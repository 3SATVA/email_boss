import { pgArray, type Db } from "../db";
import type { Manifest } from "../brands/schema";

/**
 * Upsert brand settings + sequence definitions from the manifest into the DB.
 * Brand repos own: from/reply-to, address, sequences, steps, templates.
 * The DB owns: status, warm-up start, daily cap override, API key hash.
 * Sequences removed from a brand repo are archived (running enrollments then exit).
 */
export async function syncManifestToDb(db: Db, manifest: Manifest): Promise<{ brands: string[]; sequences: number; steps: number }> {
  let sequences = 0;
  let steps = 0;
  const slugs: string[] = [];
  await db.transaction(async (tx) => {
    for (const bundle of Object.values(manifest.brands)) {
      const c = bundle.config;
      const [brand] = await tx.query<{ id: string }>(
        `insert into email_boss.brands (slug, name, from_name, from_email, reply_to, sending_domain, physical_address,
                                         timezone, provider, ses_configuration_set, links_base_url)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (slug) do update set
           name = excluded.name, from_name = excluded.from_name, from_email = excluded.from_email,
           reply_to = excluded.reply_to, sending_domain = excluded.sending_domain,
           physical_address = excluded.physical_address, timezone = excluded.timezone,
           provider = excluded.provider, ses_configuration_set = excluded.ses_configuration_set,
           links_base_url = excluded.links_base_url
         returning id`,
        [c.slug, c.name, c.from_name, c.from_email, c.reply_to ?? null, c.sending_domain, c.physical_address,
          c.timezone, c.provider ?? null, c.ses_configuration_set ?? null, c.links_base_url ?? null],
      );
      slugs.push(c.slug);

      const keys: string[] = [];
      for (const seq of bundle.sequences) {
        keys.push(seq.key);
        const { type, ...config } = seq.trigger;
        const [row] = await tx.query<{ id: string }>(
          `insert into email_boss.sequences (brand_id, key, name, trigger_type, trigger_config, status, allow_reenroll, exit_tags)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::text[])
           on conflict (brand_id, key) do update set
             name = excluded.name, trigger_type = excluded.trigger_type, trigger_config = excluded.trigger_config,
             status = excluded.status, allow_reenroll = excluded.allow_reenroll, exit_tags = excluded.exit_tags
           returning id`,
          [brand.id, seq.key, seq.name, type, JSON.stringify(config), seq.status, seq.allow_reenroll, pgArray(seq.exit_tags)],
        );
        sequences++;
        // Free up positions first (positions are deferrable-unique, keys are stable identities).
        await tx.query(`update email_boss.sequence_steps set position = position + 100000 where sequence_id = $1`, [row.id]);
        for (const [i, st] of seq.steps.entries()) {
          await tx.query(
            `insert into email_boss.sequence_steps (sequence_id, brand_id, position, key, delay_minutes, template_id, subject_override)
             values ($1, $2, $3, $4, $5, $6, $7)
             on conflict (sequence_id, key) do update set
               position = excluded.position, delay_minutes = excluded.delay_minutes,
               template_id = excluded.template_id, subject_override = excluded.subject_override`,
            [row.id, brand.id, i, st.key, st.delay, st.template, st.subject ?? null],
          );
          steps++;
        }
        await tx.query(
          `delete from email_boss.sequence_steps where sequence_id = $1 and not (key = any($2::text[]))`,
          [row.id, pgArray(seq.steps.map((s) => s.key))],
        );
      }
      await tx.query(
        `update email_boss.sequences set status = 'archived' where brand_id = $1 and not (key = any($2::text[])) and status <> 'archived'`,
        [brand.id, pgArray(keys)],
      );
    }
  });
  return { brands: slugs, sequences, steps };
}
