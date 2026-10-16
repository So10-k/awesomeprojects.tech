export default function Home() {
  return (
    <main style={{ padding: '2rem', maxWidth: '40rem' }}>
      <h1 style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 'clamp(2rem, 6vw, 3.4rem)', margin: '0 0 1rem', background: 'linear-gradient(90deg, #7cf7d4, #7aa8ff 50%, #ff7ad9)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{{name}}</h1>
      <p>This is <b>{{host}}</b>, a Next.js site by <a style={{ color: '#7aa8ff' }} href="https://github.com/{{owner}}">@{{owner}}</a>.</p>
      <p>Edit <code>app/page.jsx</code> and push: it's rebuilt and live in about a minute.</p>
    </main>
  );
}
