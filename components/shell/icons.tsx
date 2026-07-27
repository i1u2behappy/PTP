interface IconProps {
  active?: boolean
  className?: string
}

/** 기본 상태(outline)와 활성/호버 상태(solid)를 겹쳐두고 CSS로만 전환한다 — JS 상태 없이 즉각 반응. */
function Toggle({ active, outline, solid }: { active?: boolean; outline: React.ReactNode; solid: React.ReactNode }) {
  if (active) return <span className="w-[18px] h-[18px] inline-block shrink-0">{solid}</span>
  return (
    <span className="relative w-[18px] h-[18px] inline-block shrink-0">
      <span className="absolute inset-0 group-hover:hidden">{outline}</span>
      <span className="absolute inset-0 hidden group-hover:block">{solid}</span>
    </span>
  )
}

export function DashboardIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="w-full h-full">
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </svg>
      } />
  )
}

export function StoreIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
          <path d="M3.5 9L4.5 4h15l1 5" />
          <path d="M4.5 9v9.5a1 1 0 001 1h13a1 1 0 001-1V9" />
          <path d="M9.5 19.5V14h5v5.5" />
          <path d="M3.5 9h17" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
          <path d="M4.5 4h15l1.3 5.6a1 1 0 01-.98 1.23V19a1 1 0 01-1 1h-4v-5.5h-5V20h-4a1 1 0 01-1-1V10.83a1 1 0 01-.98-1.23L4.5 4z" />
        </svg>
      } />
  )
}

export function ClientIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
          <rect x="3.5" y="8" width="17" height="11" rx="1.5" />
          <path d="M8.5 8V6a1.5 1.5 0 011.5-1.5h4A1.5 1.5 0 0115.5 6v2" />
          <path d="M3.5 13h17" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" className="w-full h-full">
          <path fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" d="M8.5 8V6a1.5 1.5 0 011.5-1.5h4A1.5 1.5 0 0115.5 6v2" />
          <rect fill="currentColor" fillOpacity="0.22" stroke="none" x="3.5" y="8" width="17" height="11" rx="1.5" />
          <path fill="none" stroke="currentColor" strokeWidth="1.75" d="M3.5 8h17v11a1.5 1.5 0 01-1.5 1.5h-14A1.5 1.5 0 013.5 19V8z" />
          <path fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" d="M3.5 13h17" />
        </svg>
      } />
  )
}

export function PlusIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="w-full h-full">
          <path d="M12 5v14M5 12h14" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" className="w-full h-full">
          <path d="M12 5v14M5 12h14" />
        </svg>
      } />
  )
}

export function ListIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-full h-full">
          <path d="M8 6h12M8 12h12M8 18h12" />
          <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
          <rect x="7" y="4.8" width="14" height="2.4" rx="1.2" />
          <rect x="7" y="10.8" width="14" height="2.4" rx="1.2" />
          <rect x="7" y="16.8" width="14" height="2.4" rx="1.2" />
          <circle cx="3.2" cy="6" r="1.6" />
          <circle cx="3.2" cy="12" r="1.6" />
          <circle cx="3.2" cy="18" r="1.6" />
        </svg>
      } />
  )
}

export function SearchIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-full h-full">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M20 20l-4.8-4.8" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="w-full h-full">
          <circle cx="10.5" cy="10.5" r="6.5" fill="currentColor" fillOpacity="0.2" />
          <path d="M20 20l-4.8-4.8" />
        </svg>
      } />
  )
}

export function InboxIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
          <path d="M4 12h4l1.5 2.5h5L16 12h4" />
          <path d="M4 12l1.2-6.4A1 1 0 016.2 4.8h11.6a1 1 0 01.98.77L20 12v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6z" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
          <path d="M6.2 4.8h11.6a1 1 0 01.98.77L20 12v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6l1.2-6.43a1 1 0 01.98-.77z" fillOpacity="0.22" />
          <path d="M4 12h4l1.5 2.5h5L16 12h4v1.2h-3.5l-1.5 2.5h-5.6l-1.5-2.5H4V12z" />
        </svg>
      } />
  )
}

export function ArchiveIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
          <rect x="3.5" y="4" width="17" height="4.5" rx="1" />
          <path d="M4.5 8.5V19a1 1 0 001 1h13a1 1 0 001-1V8.5" />
          <path d="M10 13h4" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
          <rect x="3.5" y="4" width="17" height="4.5" rx="1" />
          <path d="M4.5 9.3h15V19a1 1 0 01-1 1h-13a1 1 0 01-1-1V9.3z" fillOpacity="0.85" />
        </svg>
      } />
  )
}

export function ExportIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
          <path d="M7 3.5h7l4 4V19a1 1 0 01-1 1H7a1 1 0 01-1-1V4.5a1 1 0 011-1z" />
          <path d="M14 3.5V8h4" />
          <path d="M12 11v6M9.5 14.5L12 17l2.5-2.5" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" className="w-full h-full">
          <path fill="currentColor" fillOpacity="0.22" stroke="none" d="M7 3.5h7l4 4V19a1 1 0 01-1 1H7a1 1 0 01-1-1V4.5a1 1 0 011-1z" />
          <path fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" d="M14 3.5V8h4" />
          <path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" d="M12 11v6M9.5 14.5L12 17l2.5-2.5" />
        </svg>
      } />
  )
}

export function SettingsIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-full h-full">
          <path d="M4 7h9M17 7h3" /><circle cx="14" cy="7" r="2" />
          <path d="M4 12h3M11 12h9" /><circle cx="8" cy="12" r="2" />
          <path d="M4 17h9M17 17h3" /><circle cx="14" cy="17" r="2" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-full h-full">
          <path d="M4 7h9M17 7h3" /><circle cx="14" cy="7" r="2.4" fill="currentColor" />
          <path d="M4 12h3M11 12h9" /><circle cx="8" cy="12" r="2.4" fill="currentColor" />
          <path d="M4 17h9M17 17h3" /><circle cx="14" cy="17" r="2.4" fill="currentColor" />
        </svg>
      } />
  )
}

export function ReviewIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
          <rect x="4" y="3.5" width="16" height="17" rx="1.5" />
          <path d="M7.5 8h5M7.5 12h9" />
          <path d="M7.5 16l1.3 1.3L11.5 14.6" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" className="w-full h-full">
          <rect fill="currentColor" fillOpacity="0.2" stroke="none" x="4" y="3.5" width="16" height="17" rx="1.5" />
          <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M7.5 8h5M7.5 12h9" />
          <path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" d="M7.5 16l1.3 1.3L11.5 14.6" />
        </svg>
      } />
  )
}

export function ImageEditIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
          <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="M4 17l5-5 3 3 4-4.5 4 4" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" className="w-full h-full">
          <rect fill="currentColor" fillOpacity="0.22" stroke="none" x="3.5" y="4.5" width="17" height="15" rx="1.5" />
          <path fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" d="M3.5 4.5h17v15h-17z" />
          <circle fill="currentColor" stroke="none" cx="8.5" cy="9.5" r="1.5" />
          <path fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" d="M4 17l5-5 3 3 4-4.5 4 4" />
        </svg>
      } />
  )
}

export function TagIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
          <path d="M12.5 3.5h5a2 2 0 012 2v5l-9.5 9.5a1.5 1.5 0 01-2.12 0l-4.88-4.88a1.5 1.5 0 010-2.12L12.5 3.5z" />
          <circle cx="16" cy="7" r="1.4" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" className="w-full h-full">
          <path fill="currentColor" fillOpacity="0.22" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" d="M12.5 3.5h5a2 2 0 012 2v5l-9.5 9.5a1.5 1.5 0 01-2.12 0l-4.88-4.88a1.5 1.5 0 010-2.12L12.5 3.5z" />
          <circle fill="currentColor" stroke="none" cx="16" cy="7" r="1.4" />
        </svg>
      } />
  )
}

export function MapIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
          <path d="M9 4.5L4 6.5v13l5-2 6 2 5-2v-13l-5 2-6-2z" />
          <path d="M9 4.5v13M15 6.5v13" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" className="w-full h-full">
          <path fill="currentColor" fillOpacity="0.22" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" d="M9 4.5L4 6.5v13l5-2 6 2 5-2v-13l-5 2-6-2z" />
          <path fill="none" stroke="currentColor" strokeWidth="1.5" d="M9 4.5v13M15 6.5v13" />
        </svg>
      } />
  )
}

export function CoinIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="w-full h-full">
          <circle cx="12" cy="12" r="8.5" />
          <path strokeLinecap="round" d="M12 7.5v9M9.5 9.5h4a1.75 1.75 0 010 3.5h-3a1.75 1.75 0 000 3.5h4.5" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" className="w-full h-full">
          <circle fill="currentColor" fillOpacity="0.22" stroke="currentColor" strokeWidth="1.75" cx="12" cy="12" r="8.5" />
          <path fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" d="M12 7.5v9M9.5 9.5h4a1.75 1.75 0 010 3.5h-3a1.75 1.75 0 000 3.5h4.5" />
        </svg>
      } />
  )
}

export function RefreshIcon({ active }: IconProps) {
  return (
    <Toggle active={active}
      outline={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
          <path d="M4.5 12a7.5 7.5 0 0112.6-5.5M19.5 12a7.5 7.5 0 01-12.6 5.5" />
          <path d="M17 3.5v3.5h-3.5M7 20.5V17h3.5" />
        </svg>
      }
      solid={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
          <path d="M4.5 12a7.5 7.5 0 0112.6-5.5M19.5 12a7.5 7.5 0 01-12.6 5.5" />
          <path d="M17 3.5v3.5h-3.5M7 20.5V17h3.5" />
        </svg>
      } />
  )
}

export function BoltIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  )
}

export type IconComponent = (props: IconProps) => React.ReactNode

/** 탭 id → 사이드바 메뉴와 동일한 아이콘. 하단 탭바(TabBar)가 이모지 대신 이 아이콘을 쓰도록
 *  Sidebar.tsx의 메뉴별 아이콘 배정과 짝을 맞춰 관리한다(메뉴에 새 항목을 추가하면 여기도 추가). */
export const TAB_ICONS: Record<string, IconComponent> = {
  'dashboard': DashboardIcon,
  'clients-list': ClientIcon,
  'sites-list': StoreIcon,
  'scraper': SearchIcon,
  'products-list': InboxIcon,
  'migration-dashboard': ReviewIcon,
  'master-schema': ArchiveIcon,
  'sales-code': TagIcon,
  'category-mapping': MapIcon,
  'internal-codes': TagIcon,
  'name-management': ListIcon,
  'option-management': SettingsIcon,
  'brand-origin-management': StoreIcon,
  'image-edit': ImageEditIcon,
  'image-host': ImageEditIcon,
  'pricing-management': CoinIcon,
  'master-list': ArchiveIcon,
  'transform': ReviewIcon,
  'continuous-migration': RefreshIcon,
  'export': ExportIcon,
  'settings': SettingsIcon,
}
