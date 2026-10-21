import type { Db } from "../db";
import { pgArray } from "../db";
import type { Manifest } from "../brands/schema";
import { getBrandBundle } from "../brands/registry";
import { renderEmail } from "../templates";
import { oneClickUnsubscribeUrl, requireUnsubscribeSecret, signUnsubscribeToken, unsubscribeUrl } from "../tokens";
import { chooseProviderName, defaultProviderResolver, formatFrom, PermanentSendError, type ProviderResolver } from "../providers";
import { enrollContact } from "./contacts";
import { addMinutes, dailyCap } from "./schedule";
import type { BrandRow, ContactRow } from "./types";

export interface TickOptions {
  now?: Date;
  manifest?: Manifest;
  resolveProvider?: ProviderResolver;
  env?: NodeJS.ProcessEnv;
  /** max sends per tick across all brands (keeps a run inside the function time limit) */
  maxSends?: number;
  /** stop claiming new sends after this many ms */
  timeBudgetMs?: number;
  /** throttle; SES sandbox = 1/s, production starts at 14/s. 0 = no throttle (tests) */
  perSecond?: number;
  /** override the warm-up schedule (tests) */
  warmupSchedule?: readonly number[];
  maxAttempts?: number;
}

export interface TickSummary {
  dateEnrolled: number;
  stepsQueued: number;
  enrollmentsCompleted: number;
  enrollmentsExited: number;
  broadcastsMaterialized: number;
  sent: number;
  failed: number;
  skipped: number;
  retried: number;
  capped: Record<string, { cap: number; sentToday: number }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One scheduler pass. Safe to run concurrently (row locks + unique keys make it idempotent). */
export async function runTick(db: Db, opts: TickOptions = {}): Promise<TickSummary> {
  const now = opts.now ?? new Date();
  const summary: TickSummary = {
    dateEnrolled: 0, stepsQueued: 0, enrollmentsCompleted: 0, enrollmentsExited: 0,
    broadcastsMaterialized: 0, sent: 0, failed: 0, skipped: 0, retried: 0, capped: {},
  };
  await recoverStaleClaims(db, now);
  summary.dateEnrolled = await enrollDateTriggered(db, now);
  await advanceEnrollments(db, now, summary);
  summary.broadcastsMaterialized = await materializeBroadcasts(db, now);
  await deliverQueued(db, now, opts, summary);
  await finishBroadcasts(db, now);
  return summary;
}

/** A send stuck in "sending" (function crashed mid-send) is marked failed, never re-sent blindly. */
async function recoverStaleClaims(db: Db, now: Date) {
  await db.query(
    `update email_boss.sends set status = 'failed', error = 'stale claim: process died while sending; check provider logs before retrying'
      where status = 'sending' and claimed_at < $1::timestamptz`,
    [addMinutes(now, -15).toISOString()],
  );
}

/** Enroll contacts whose custom date field (+offset) is today, for active `date` sequences. */
export async function enrollDateTriggered(db: Db, now: Date): Promise<number> {
  const seqs = await db.query<{ id: string; brand_id: string; timezone: string; field: string; offset_days: number; annual: boolean }>(
    `select s.id, s.brand_id, b.timezone,
            s.trigger_config->>'field' as field,
            coalesce((s.trigger_config->>'offset_days')::int, 0) as offset_days,
            coalesce((s.trigger_config->>'annual')::boolean, false) as annual
       from email_boss.sequences s join email_boss.brands b on b.id = s.brand_id
      where s.trigger_type = 'date' and s.status = 'active' and b.status = 'active'`,
  );
  let n = 0;
  for (const s of seqs) {
    // target date = today (brand tz) - offset. offset -7 means "7 days before the date".
    const rows = await db.query<{ id: string; cycle_key: string }>(
      `with today as (select (($1::timestamptz at time zone $2)::date - $3::int) as d)
       select c.id,
              case when $5::boolean then extract(year from (select d from today))::int::text else '' end as cycle_key
         from email_boss.contacts c
        where c.brand_id = $4 and c.status = 'subscribed'
          and email_boss.try_date(c.custom_fields->>$6) is not null
          and case when $5::boolean
                then to_char(email_boss.try_date(c.custom_fields->>$6), 'MM-DD') = to_char((select d from today), 'MM-DD')
                else email_boss.try_date(c.custom_fields->>$6) = (select d from today) end
        limit 5000`,
      [now.toISOString(), s.timezone, -s.offset_days, s.brand_id, s.annual, s.field],
    );
    for (const r of rows) {
      if (await enrollContact(db, { brandId: s.brand_id, sequenceId: s.id, contactId: r.id, now, cycleKey: r.cycle_key })) n++;
    }
  }
  return n;
}

/** Turn due enrollment steps into queued sends and schedule the next step. */
export async function advanceEnrollments(db: Db, now: Date, summary: TickSummary, batch = 500) {
  for (let round = 0; round < 20; round++) {
    const processed = await db.transaction(async (tx) => {
      const due = await tx.query<{
        id: string; brand_id: string; sequence_id: string; contact_id: string; current_position: number;
        contact_status: string; seq_status: string; has_exit_tag: boolean;
      }>(
        `select e.id, e.brand_id, e.sequence_id, e.contact_id, e.current_position,
                c.status as contact_status, s.status as seq_status,
                exists (
                  select 1 from email_boss.contact_tags ct join email_boss.tags t on t.id = ct.tag_id
                   where ct.contact_id = e.contact_id and t.name = any(s.exit_tags)
                ) as has_exit_tag
           from email_boss.enrollments e
           join email_boss.contacts c on c.id = e.contact_id and c.brand_id = e.brand_id
           join email_boss.sequences s on s.id = e.sequence_id and s.brand_id = e.brand_id
           join email_boss.brands b on b.id = e.brand_id
          where e.status = 'active' and e.next_run_at <= $1::timestamptz
            and b.status = 'active' and s.status in ('active', 'archived')
          order by e.next_run_at
          limit $2
          for update of e skip locked`,
        [now.toISOString(), batch],
      );
      for (const e of due) {
        const exitReason =
          e.seq_status === "archived" ? "sequence_archived"
          : e.contact_status !== "subscribed" ? `contact_${e.contact_status}`
          : e.has_exit_tag ? "exit_tag" : null;
        if (exitReason) {
          await tx.query(
            `update email_boss.enrollments set status = 'exited', exit_reason = $2, next_run_at = null where id = $1`,
            [e.id, exitReason],
          );
          summary.enrollmentsExited++;
          continue;
        }
        const steps = await tx.query<{ id: string; position: number; delay_minutes: number; template_id: string; subject_override: string | null }>(
          `select id, position, delay_minutes, template_id, subject_override from email_boss.sequence_steps
            where sequence_id = $1 and position >= $2 order by position limit 2`,
          [e.sequence_id, e.current_position],
        );
        const step = steps[0];
        if (!step) {
          await tx.query(
            `update email_boss.enrollments set status = 'completed', completed_at = $2::timestamptz, next_run_at = null where id = $1`,
            [e.id, now.toISOString()],
          );
          summary.enrollmentsCompleted++;
          continue;
        }
        const ins = await tx.query(
          `insert into email_boss.sends (brand_id, contact_id, kind, enrollment_id, step_id, template_id, subject_override, priority, scheduled_for)
           values ($1, $2, 'sequence', $3, $4, $5, $6, 10, $7::timestamptz)
           on conflict (enrollment_id, step_id) do nothing returning id`,
          [e.brand_id, e.contact_id, e.id, step.id, step.template_id, step.subject_override, now.toISOString()],
        );
        if (ins.length) summary.stepsQueued++;
        const next = steps[1];
        if (next) {
          await tx.query(
            `update email_boss.enrollments set current_position = $2, next_run_at = $3::timestamptz where id = $1`,
            [e.id, next.position, addMinutes(now, next.delay_minutes).toISOString()],
          );
        } else {
          await tx.query(
            `update email_boss.enrollments set status = 'completed', current_position = $2, completed_at = $3::timestamptz, next_run_at = null where id = $1`,
            [e.id, step.position + 1, now.toISOString()],
          );
          summary.enrollmentsCompleted++;
        }
      }
      return due.length;
    });
    if (processed < batch) break;
  }
}

/** Expand due broadcasts into one queued send per matching subscribed contact of that brand. */
export async function materializeBroadcasts(db: Db, now: Date): Promise<number> {
  const due = await db.query<{ id: string; brand_id: string; segment: { include_tags?: string[]; exclude_tags?: string[]; match?: string } }>(
    `select bc.id, bc.brand_id, bc.segment from email_boss.broadcasts bc join email_boss.brands b on b.id = bc.brand_id
      where bc.status = 'scheduled' and bc.scheduled_at <= $1::timestamptz and b.status = 'active'`,
    [now.toISOString()],
  );
  for (const bc of due) {
    const include = (bc.segment.include_tags ?? []).map(String);
    const exclude = (bc.segment.exclude_tags ?? []).map(String);
    const matchAll = bc.segment.match === "all";
    await db.transaction(async (tx) => {
      const locked = await tx.query(`select id from email_boss.broadcasts where id = $1 and status = 'scheduled' for update skip locked`, [bc.id]);
      if (!locked.length) return;
      await tx.query(
        `insert into email_boss.sends (brand_id, contact_id, kind, broadcast_id, template_id, subject_override, priority, scheduled_for)
         select bc.brand_id, c.id, 'broadcast', bc.id, bc.template_id, bc.subject_override, 50, $2::timestamptz
           from email_boss.broadcasts bc
           join email_boss.contacts c on c.brand_id = bc.brand_id and c.status = 'subscribed'
          where bc.id = $1
            and (
              cardinality($3::text[]) = 0
              or ($5::boolean and (select count(distinct t.name) from email_boss.contact_tags ct join email_boss.tags t on t.id = ct.tag_id
                                    where ct.contact_id = c.id and t.name = any($3::text[])) = cardinality($3::text[]))
              or (not $5::boolean and exists (select 1 from email_boss.contact_tags ct join email_boss.tags t on t.id = ct.tag_id
                                    where ct.contact_id = c.id and t.name = any($3::text[])))
            )
            and not exists (select 1 from email_boss.contact_tags ct join email_boss.tags t on t.id = ct.tag_id
                             where ct.contact_id = c.id and t.name = any($4::text[]))
         on conflict (broadcast_id, contact_id) do nothing`,
        [bc.id, now.toISOString(), pgArray(include), pgArray(exclude), matchAll],
      );
      await tx.query(
        `update email_boss.broadcasts set status = 'sending', materialized_at = $2::timestamptz,
                recipient_count = (select count(*)::int from email_boss.sends where broadcast_id = $1)
          where id = $1`,
        [bc.id, now.toISOString()],
      );
    });
  }
  return due.length;
}

async function finishBroadcasts(db: Db, now: Date) {
  await db.query(
    `update email_boss.broadcasts bc set status = 'sent', completed_at = $1::timestamptz
      where bc.status = 'sending'
        and not exists (select 1 from email_boss.sends s where s.broadcast_id = bc.id and s.status in ('queued', 'sending'))`,
    [now.toISOString()],
  );
}

/** Sends still allowed today for a brand (warm-up cap minus what already went out today, brand-local day). */
export async function remainingToday(db: Db, brand: BrandRow, now: Date, schedule?: readonly number[]) {
  const rows = await db.query<{ sent_today: number; day_index: number | null }>(
    `select
       (select count(*)::int from email_boss.sends s
         where s.brand_id = $1 and s.status in ('sent', 'sending')
           and coalesce(s.sent_at, s.claimed_at) >= (date_trunc('day', $2::timestamptz at time zone $3) at time zone $3)) as sent_today,
       (($2::timestamptz at time zone $3)::date - $4::date) as day_index`,
    [brand.id, now.toISOString(), brand.timezone, brand.warmup_started_on ? toDateString(brand.warmup_started_on) : null],
  );
  const cap = dailyCap({ warmupDayIndex: rows[0].day_index, override: brand.daily_cap_override, schedule });
  return { cap, sentToday: rows[0].sent_today, remaining: Math.max(0, cap - rows[0].sent_today) };
}

function toDateString(d: string | Date): string {
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10); // pg `date` columns arrive as UTC-midnight Dates
}

export async function deliverQueued(db: Db, now: Date, opts: TickOptions, summary: TickSummary) {
  const env = opts.env ?? process.env;
  const manifest = opts.manifest;
  const resolve = opts.resolveProvider ?? defaultProviderResolver;
  const maxSends = opts.maxSends ?? Number(env.SEND_BATCH_LIMIT ?? 200);
  const perSecond = opts.perSecond ?? Number(env.SEND_RATE_PER_SECOND ?? 1);
  const budget = opts.timeBudgetMs ?? Number(env.SEND_TIME_BUDGET_MS ?? 45_000);
  const maxAttempts = opts.maxAttempts ?? 3;
  const started = Date.now();
  const gap = perSecond > 0 ? 1000 / perSecond : 0;
  let total = 0;

  const brands = await db.query<BrandRow>(
    `select b.* from email_boss.brands b
      where b.status = 'active'
        and exists (select 1 from email_boss.sends s where s.brand_id = b.id and s.status = 'queued' and s.scheduled_for <= $1::timestamptz)
      order by b.slug`,
    [now.toISOString()],
  );

  for (const brand of brands) {
    const bundle = getBrandBundle(brand.slug, manifest);
    while (total < maxSends && Date.now() - started < budget) {
      const claimed = await db.transaction(async (tx) => {
        await tx.query(`select id from email_boss.brands where id = $1 for update`, [brand.id]);
        const r = await remainingToday(tx, brand, now, opts.warmupSchedule);
        summary.capped[brand.slug] = { cap: r.cap, sentToday: r.sentToday };
        const take = Math.min(r.remaining, maxSends - total, 25);
        if (take <= 0) return [];
        return tx.query<{ id: string; contact_id: string; template_id: string; subject_override: string | null; attempts: number; kind: string }>(
          `update email_boss.sends set status = 'sending', claimed_at = $3::timestamptz, attempts = attempts + 1
            where id in (
              select id from email_boss.sends
               where brand_id = $1 and status = 'queued' and scheduled_for <= $3::timestamptz
               order by priority, scheduled_for, created_at
               limit $2 for update skip locked)
           returning id, contact_id, template_id, subject_override, attempts, kind`,
          [brand.id, take, now.toISOString()],
        );
      });
      if (!claimed.length) break;

      for (const send of claimed) {
        total++;
        const outcome = await deliverOne(db, brand, send, { bundle, env, now, resolve });
        if (outcome === "sent") summary.sent++;
        else if (outcome === "skipped") summary.skipped++;
        else if (outcome === "retry" && send.attempts < maxAttempts) {
          summary.retried++;
          await db.query(
            `update email_boss.sends set status = 'queued', scheduled_for = $2::timestamptz where id = $1 and status = 'sending'`,
            [send.id, addMinutes(now, 10 * send.attempts).toISOString()],
          );
        } else {
          summary.failed++;
          await db.query(`update email_boss.sends set status = 'failed' where id = $1 and status = 'sending'`, [send.id]);
        }
        if (gap) await sleep(gap);
      }
    }
  }
}

type Outcome = "sent" | "skipped" | "failed" | "retry";

async function deliverOne(
  db: Db,
  brand: BrandRow,
  send: { id: string; contact_id: string; template_id: string; subject_override: string | null; kind: string },
  ctx: { bundle: ReturnType<typeof getBrandBundle>; env: NodeJS.ProcessEnv; now: Date; resolve: ProviderResolver },
): Promise<Outcome> {
  const fail = async (error: string): Promise<Outcome> => {
    await db.query(`update email_boss.sends set error = $2 where id = $1`, [send.id, error.slice(0, 1000)]);
    return "failed";
  };

  // Re-check at the last moment, scoped to the send's own brand.
  const contacts = await db.query<ContactRow>(
    `select id, brand_id, email, first_name, last_name, status, source, custom_fields
       from email_boss.contacts where id = $1 and brand_id = $2`,
    [send.contact_id, brand.id],
  );
  const contact = contacts[0];
  if (!contact || contact.status !== "subscribed") {
    await db.query(`update email_boss.sends set status = 'skipped', error = $2 where id = $1`, [send.id, `contact ${contact?.status ?? "missing"}`]);
    return "skipped";
  }

  const tpl = ctx.bundle?.templates[send.template_id];
  if (!ctx.bundle || !tpl) return fail(`template ${brand.slug}/${send.template_id} not found in manifest`);

  if (/REPLACE_ME/i.test(brand.physical_address)) return fail("brand physical_address is still a placeholder (CAN-SPAM)");
  const baseUrl = brand.links_base_url || ctx.env.PUBLIC_BASE_URL;
  if (!baseUrl) return fail("PUBLIC_BASE_URL (or brand links_base_url) is not set");

  let rendered;
  let headers: Record<string, string>;
  try {
    const token = signUnsubscribeToken(contact.id, brand.id, requireUnsubscribeSecret(ctx.env));
    const oneClick = oneClickUnsubscribeUrl(baseUrl, token);
    rendered = renderEmail(
      tpl,
      ctx.bundle.partials,
      {
        first_name: contact.first_name,
        last_name: contact.last_name,
        email: contact.email,
        custom: contact.custom_fields,
        brand: { name: brand.name, from_name: brand.from_name },
        unsubscribe_url: unsubscribeUrl(baseUrl, token),
        physical_address: brand.physical_address,
        current_year: String(ctx.now.getUTCFullYear()),
      },
      send.subject_override,
    );
    headers = {
      // RFC 2369 + RFC 8058 one-click (required by Gmail/Yahoo for bulk senders)
      "List-Unsubscribe": `<${oneClick}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  } catch (e) {
    return fail(`render: ${(e as Error).message}`);
  }

  const providerName = chooseProviderName(brand.provider, ctx.env);
  try {
    const result = await ctx.resolve(providerName).send({
      from: formatFrom(brand.from_name, brand.from_email),
      to: contact.email,
      replyTo: brand.reply_to ?? undefined,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers,
      tags: { brand: brand.slug, send_id: send.id, kind: send.kind },
      configurationSet: brand.ses_configuration_set ?? undefined,
    });
    await db.transaction(async (tx) => {
      await tx.query(
        `update email_boss.sends set status = 'sent', provider = $2, provider_message_id = $3, subject = $4,
                sent_at = $5::timestamptz, error = null where id = $1`,
        [send.id, result.provider, result.messageId, rendered.subject, ctx.now.toISOString()],
      );
      await tx.query(`update email_boss.contacts set last_sent_at = $2::timestamptz where id = $1`, [contact.id, ctx.now.toISOString()]);
      await tx.query(
        `insert into email_boss.events (brand_id, contact_id, send_id, type, occurred_at, data) values ($1, $2, $3, 'sent', $4::timestamptz, $5::jsonb)`,
        [brand.id, contact.id, send.id, ctx.now.toISOString(), JSON.stringify({ provider: result.provider, template: send.template_id })],
      );
    });
    return "sent";
  } catch (e) {
    const permanent = e instanceof PermanentSendError;
    await db.query(`update email_boss.sends set error = $2, provider = $3 where id = $1`, [send.id, String((e as Error).message).slice(0, 1000), providerName]);
    if (permanent) {
      await db.query(
        `insert into email_boss.events (brand_id, contact_id, send_id, type, occurred_at, data) values ($1, $2, $3, 'failed', $4::timestamptz, $5::jsonb)`,
        [brand.id, contact.id, send.id, ctx.now.toISOString(), JSON.stringify({ error: (e as Error).message })],
      );
      return "failed";
    }
    return "retry";
  }
}
