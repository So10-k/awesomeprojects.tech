export const metadata = { title: '{{name}}', description: '{{host}}' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100vh', display: 'grid', placeItems: 'center', fontFamily: 'ui-sans-serif, system-ui, sans-serif', background: 'linear-gradient(160deg, #0b1020, #16123a 55%, #2a0f3d)', color: '#e6ebff' }}>
        {children}
      </body>
    </html>
  );
}
