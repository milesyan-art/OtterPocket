import { useState } from 'react';

/** A site's icon, or nothing when the site blocks or lacks one (instead of an empty gap). */
export function Favicon({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
  return <img src={url} alt="" onError={() => setFailed(true)} />;
}
