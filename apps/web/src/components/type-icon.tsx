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
