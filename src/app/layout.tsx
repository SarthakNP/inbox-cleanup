import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'Inbox Cleanup',description:'Review promotional emails by sender and clear your inbox in bulk.',robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body>{children}</body></html>;
}
