import {
  Folder,
  FlaskConical,
  Library,
  Box,
  Briefcase,
  Car,
  Cloud,
  CreditCard,
  Database,
  FileText,
  Globe,
  HardDrive,
  KeyRound,
  Laptop,
  Monitor,
  Network,
  Package,
  Phone,
  Printer,
  Router,
  Server,
  Shield,
  Smartphone,
  Ticket,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import { IconTile } from './ui/display';

/** The icon vocabulary for asset types and catalogs; stored by name. */
export const typeIcons: Record<string, LucideIcon> = {
  box: Box,
  'key-round': KeyRound,
  smartphone: Smartphone,
  laptop: Laptop,
  globe: Globe,
  server: Server,
  cloud: Cloud,
  database: Database,
  shield: Shield,
  'file-text': FileText,
  'credit-card': CreditCard,
  monitor: Monitor,
  printer: Printer,
  router: Router,
  network: Network,
  wifi: Wifi,
  phone: Phone,
  'hard-drive': HardDrive,
  package: Package,
  briefcase: Briefcase,
  car: Car,
  ticket: Ticket,
  folder: Folder,
  flask: FlaskConical,
  library: Library,
};

export function TypeIcon({ icon, color, size = 28 }: { icon: string; color: string; size?: number }) {
  const Icon = typeIcons[icon] ?? Box;
  return (
    <IconTile color={color} size={size}>
      <Icon />
    </IconTile>
  );
}

const iconWords: Array<[RegExp, string]> = [
  [/laptop|notebook|macbook|מחשב נייד|לפטופ/, 'laptop'],
  [/phone|mobile|sim\b|iphone|android|טלפון|נייד|סים/, 'smartphone'],
  [/monitor|display|screen|מסך/, 'monitor'],
  [/server|rack|שרת/, 'server'],
  [/domain|website|dns|certificate|ssl|tls|דומיין|אתר|תעוד/, 'globe'],
  [/licen[cs]e|software|saas|subscription|key|רישיון|רשיון|תוכנ|מנוי/, 'key-round'],
  [/cloud|aws|azure|gcp/, 'cloud'],
  [/database|db\b/, 'database'],
  [/security|compliance|policy|insurance/, 'shield'],
  [/contract|document|agreement|חוז|מסמך|הסכם/, 'file-text'],
  [/card|payment|billing/, 'credit-card'],
  [/printer|מדפס/, 'printer'],
  [/router|switch|firewall/, 'router'],
  [/network|vpn/, 'network'],
  [/wi-?fi|access point/, 'wifi'],
  [/disk|drive|storage/, 'hard-drive'],
  [/vehicle|car\b|fleet|רכב/, 'car'],
  [/ticket|event/, 'ticket'],
  [/lab|equipment|device/, 'flask'],
  [/book|library/, 'library'],
  [/furniture|office|ריהוט|משרד/, 'briefcase'],
];

/** An icon that fits a template's name ("Laptops" → laptop), or null. */
export function guessIcon(name: string): string | null {
  const n = name.toLowerCase();
  return iconWords.find(([re]) => re.test(n))?.[1] ?? null;
}
