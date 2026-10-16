import { useState } from 'react';

export default function App() {
  const [n, setN] = useState(0);
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <div style={{ padding: '2rem', maxWidth: '40rem' }}>
        <h1 style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 'clamp(2rem, 6vw, 3.4rem)', margin: '0 0 1rem', background: 'linear-gradient(90deg, #7cf7d4, #7aa8ff 50%, #ff7ad9)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{{name}}</h1>
        <p>This is <b>{{host}}</b>, a Vite + React app by @{{owner}}.</p>
        <button onClick={() => setN(n + 1)} style={{ font: 'inherit', padding: '0.5rem 1rem', borderRadius: 10, border: 0, background: '#7cf7d4', color: '#0b1020', cursor: 'pointer' }}>Clicked {n} times</button>
        <p>Edit <code>src/App.jsx</code> and push.</p>
      </div>
    </main>
  );
}
