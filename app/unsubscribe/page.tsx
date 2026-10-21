import { getDb, isDbConfigured } from "@/lib/db";
import { unsubscribeSecrets, verifyUnsubscribeToken } from "@/lib/tokens";

export const dynamic = "force-dynamic";

export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  const claims = verifyUnsubscribeToken(t, unsubscribeSecrets());
  if (!claims) {
    return (
      <main className="center">
        <h1>This link isn&apos;t valid</h1>
        <p className="muted">Please use the unsubscribe link from the bottom of the most recent email, or reply to it and ask to be removed.</p>
      </main>
    );
  }
  let brandName = "these emails";
  let already = false;
  if (isDbConfigured()) {
    try {
      const rows = await getDb().query<{ name: string; status: string }>(
        `select b.name, c.status from email_boss.contacts c join email_boss.brands b on b.id = c.brand_id
          where c.id = $1 and c.brand_id = $2`,
        [claims.contactId, claims.brandId],
      );
      if (rows[0]) {
        brandName = rows[0].name;
        already = rows[0].status !== "subscribed";
      }
    } catch (e) {
      console.error(e);
    }
  }
  if (already) {
    return (
      <main className="center">
        <h1>You&apos;re already unsubscribed</h1>
        <p className="muted">You won&apos;t receive any more marketing emails from {brandName}.</p>
      </main>
    );
  }
  return (
    <main className="center">
      <h1>Unsubscribe from {brandName}?</h1>
      <p className="muted">You&apos;ll stop receiving marketing emails from {brandName}. This doesn&apos;t affect any other list.</p>
      <form method="post" action="/api/unsubscribe">
        <input type="hidden" name="t" value={t} />
        <button type="submit">Yes, unsubscribe me</button>
      </form>
    </main>
  );
}
