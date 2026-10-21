export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const configured = Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 12);
  return (
    <main className="center">
      <h1>Dashboard login</h1>
      {!configured && <p className="warn">Set ADMIN_PASSWORD (12+ characters) to enable the dashboard.</p>}
      {error && <p className="warn">Wrong password.</p>}
      <form method="post" action="/api/admin/login" style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        <input type="password" name="password" placeholder="Admin password" autoComplete="current-password" required />
        <button type="submit">Log in</button>
      </form>
    </main>
  );
}
