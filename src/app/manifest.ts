import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Clearbox — Your Inbox Command Center',
    short_name: 'Clearbox',
    description: 'Triage, prioritize, and manage your Gmail inbox with AI-powered intelligence.',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#f8f9fa',
    theme_color: '#4f46e5',
    orientation: 'portrait',
    icons: [
      { src: '/clearbox-logo-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/clearbox-logo-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/clearbox-logo-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/clearbox-logo-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
