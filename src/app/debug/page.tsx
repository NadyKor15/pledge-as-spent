// Entry to the debug pages: open a fresh demo drive and land on its debug view.

export default function DebugIndex() {
  return (
    <main style={{ fontFamily: "monospace", padding: 16 }}>
      <h1>Pledge-as-Spent debug</h1>
      <form method="post" action="/api/demo/drives">
        <input type="hidden" name="back" value="1" />
        <button type="submit">New demo drive</button>
      </form>
      <p>Or open /debug/drive/&lt;drive id&gt;.</p>
    </main>
  );
}
