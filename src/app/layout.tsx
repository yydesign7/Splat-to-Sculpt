import type { Metadata } from 'next';
import { Inspector } from 'react-dev-inspector';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Splat to Sculpt | Node-based 3D Gaussian Model Generator',
    template: '%s | Splat to Sculpt',
  },
  description: 'Node-based 3D Gaussian Splatting (3DGS) model generation tool with video upload, frame extraction, point cloud generation, material generation and 3DGS model preview.',
  keywords: [
    '3DGS',
    '3D Gaussian Splatting',
    'Point Cloud',
    'Node Editor',
    'ComfyUI',
    '3D Model',
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDev = process.env.COZE_PROJECT_ENV === 'DEV';

  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        {isDev && <Inspector />}
        {children}
      </body>
    </html>
  );
}
