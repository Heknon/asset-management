import { Fragment, type ReactNode } from 'react';
import { t } from './i18n';

/**
 * A translated sentence with elements placed inside it, so word order can
 * change between languages:
 *
 *   tj('Signed in as {name}', { name: <b>{me.displayName}</b> })
 *   tj('{count} items · shared with {who}', { count: 3, who: <Link …/> })
 */
export function tj(text: string, parts: Record<string, ReactNode>): ReactNode {
  const translated = t(text);
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of translated.matchAll(/\{(\w+)\}/g)) {
    if (m.index > last) out.push(translated.slice(last, m.index));
    out.push(m[1]! in parts ? parts[m[1]!] : m[0]);
    last = m.index + m[0].length;
  }
  if (last < translated.length) out.push(translated.slice(last));
  return out.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}
