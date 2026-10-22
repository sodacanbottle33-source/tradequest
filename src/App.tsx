import { useState } from 'react';
import { SharedApp } from './shared/SharedApp';
import type { Mode } from './ui/Header';

// The game has three places: Career (the market and your account), 1v1 battles, and News. They all use the same permanent,
// server-run market with the same companies. (The older offline Practice and Classic-round modes are no longer in the menu.)
export function App() {
  const [mode, setMode] = useState<Mode>('career');
  return <SharedApp mode={mode} onMode={setMode} />;
}
