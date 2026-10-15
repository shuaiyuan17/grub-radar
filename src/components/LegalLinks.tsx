import { PRIVACY_PATH, TERMS_PATH } from '../contracts/legal';
import { useT } from '../i18n/context';
import styles from './LegalLinks.module.css';

/**
 * Links to the Privacy Policy and Terms of Service. Plain <a>, not a router
 * Link: the pages are server-rendered by the Worker, outside the SPA.
 */
export function LegalLinks({ className }: { className?: string }) {
  const t = useT();
  return (
    <nav aria-label={t.legal.label} className={`${styles.links} ${className ?? ''}`.trim()}>
      <a href={PRIVACY_PATH}>{t.legal.privacy}</a>
      <span aria-hidden="true">·</span>
      <a href={TERMS_PATH}>{t.legal.terms}</a>
    </nav>
  );
}
