// The picture of a stock or memecoin (a small rounded square), or, while it has none, its first letters on a colour that is the same every time.
// Pictures come from the server (/api/company-picture/<ticker>); the page learns which companies have one from src/shared/logoStore.ts.
import { useEffect, useState } from 'react';
import { companyPictureUrl, useLogos } from './logoStore';
import { logoColour, logoLetters } from './logoUtil';

/** The logo of one company. `size` is in pixels. */
export function CompanyLogo({ ticker, size = 28, className }: { ticker: string; size?: number; className?: string }) {
  const { pictures } = useLogos();
  const version = pictures[ticker];
  const [failed, setFailed] = useState(false);
  // A new picture (or a removed one) gives the browser another chance.
  useEffect(() => setFailed(false), [version]);
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) };
  if (version !== undefined && !failed) {
    return <img className={className ? `logo ${className}` : 'logo'} src={companyPictureUrl(ticker, version)} alt="" width={size} height={size} style={style} loading="lazy" onError={() => setFailed(true)} data-testid={`logo-${ticker}`} />;
  }
  return (
    <span className={className ? `logo logo-letters ${className}` : 'logo logo-letters'} style={{ ...style, background: logoColour(ticker) }} aria-hidden="true" data-testid={`logo-${ticker}`}>
      {logoLetters(ticker, size)}
    </span>
  );
}
