// Edit this file to re-label the entire site. Header, Footer, the homepage
// and SEO defaults all read from here instead of hardcoding copy.
export const SITE = {
  name: 'Aman Gupta',
  role: 'Rust Backend Engineer · Blockchain Infrastructure · Web3',
  email: 'amangupta432005@gmail.com',
  tagline: 'Backend and blockchain engineer working with Rust, blockchain infrastructure, DeFi and smart contracts.',
  description:
    'Engineering portfolio of Aman Gupta, focused on Rust backend engineering, blockchain infrastructure, distributed systems, and Web3 backend systems.',
  status: 'Open to full-time and freelance opportunities',
  location: 'India / Remote',
  social: [
    { label: 'GitHub', href: 'https://github.com/AmanGUPTA435' },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/aman-gupta-1b5643255/' },
    { label: 'X', href: 'https://x.com/vahz_aman' },
  ],
  locale: 'en',
} as const;

export const NAV_LINKS = [
  { label: 'Work', href: '/work' },
  { label: 'About', href: '/about' },
  { label: 'Notes', href: '/notes' },
  { label: 'Contact', href: '/#contact' },
] as const;
