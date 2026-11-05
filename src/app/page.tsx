import { CryptoyarApp } from '@/components/cryptoyar/cryptoyar-app'

// The whole dashboard is a client-driven terminal: data arrives via polling
// after mount, so the first server render and the first client render are
// identical skeletons — no hydration mismatch is possible by design.
export default function Page() {
  return <CryptoyarApp />
}
