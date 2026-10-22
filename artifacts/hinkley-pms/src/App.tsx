import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ClerkProvider, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import NotFound from '@/pages/not-found';
import { Link, Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  AlertTriangle, ArrowUpRight, Building2, CalendarDays, ClipboardList, House, LayoutDashboard, LogOut, Menu, PlugZap, PoundSterling, Search, Users, Wrench, X,
} from 'lucide-react';
import {
  getGetCohoStatusQueryKey,
  getGetMoneyOverviewQueryKey,
  getListCohoCalendarQueryKey,
  getListCohoPropertiesQueryKey,
  type CohoProperty,
  useGetCohoStatus,
  useGetMoneyOverview,
  useListCohoCalendar,
  useListCohoProperties,
} from '@workspace/api-client-react';
import CohoMaintenancePage from '@/pages/coho-maintenance';
import CalendarPage from '@/pages/calendar';
import ActionsPage from '@/pages/actions';
import PropertiesPage from '@/pages/properties/PropertiesPage';
import PropertyDetailPage from '@/pages/properties/PropertyDetailPage';
import OccupancyPage from '@/pages/occupancy/OccupancyPage';
import ListingsWidget from '@/pages/listings-widget';
import { MoneyPanels, formatPounds } from '@/components/overview/MoneyPanels';
import {
  AccessRestrictedPage,
  AuthLandingPage,
  AuthLoadingPage,
  SignInPage,
  SignUpPage,
} from '@/pages/auth';
import { isAllowedStaffEmail } from '@/lib/staff-email';

// Browsers that used the old prototype still hold its demo records under this key.
const LEGACY_DEMO_STORAGE = 'hinkley-pms-demo-v1';
const navGroups = [
  { label: 'CORE', items: [['/dashboard', 'Overview', LayoutDashboard], ['/properties', 'Properties', Building2]] },
  { label: 'OPERATIONS', items: [['/calendar', 'Calendar', CalendarDays], ['/occupancy', 'Occupancy', Users], ['/actions', 'Actions', ClipboardList], ['/maintenance', 'Maintenance', Wrench]] },
] as const;
const initials = (s: string) => s.split(' ').map(a => a[0]).slice(0, 2).join('').toUpperCase();
const greeting = (date: Date) => date.getHours() < 12 ? 'Good morning' : date.getHours() < 18 ? 'Good afternoon' : 'Good evening';
const queryClient = new QueryClient();

function AppShell() {
  const [path] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();
  const profileEmail = user?.primaryEmailAddress?.emailAddress ?? '';
  const metadataName = typeof user?.unsafeMetadata?.fullName === 'string' ? user.unsafeMetadata.fullName.trim() : '';
  const profileName = metadataName || user?.fullName || profileEmail.split('@')[0] || 'Hinkley staff';
  const profileInitials = initials(profileName);
  const [global, setGlobal] = useState('');
  const [branch, setBranch] = useState('all');
  const [toast, setToast] = useState('');
  const [sideOpen, setSideOpen] = useState(false);
  const cohoStatusQuery = useGetCohoStatus({ query: { queryKey: getGetCohoStatusQueryKey(), refetchInterval: 15_000 } });
  const cohoConfigured = cohoStatusQuery.data?.configured === true;
  const cohoPropertiesQuery = useListCohoProperties({ page: 1, pageSize: 100 }, { query: { queryKey: getListCohoPropertiesQueryKey({ page: 1, pageSize: 100 }), enabled: cohoConfigured, refetchInterval: 60_000 } });
  const cohoProperties = cohoPropertiesQuery.data?.items ?? [];
  const cohoLocationGroups = useMemo(() => {
    const grouped = new Map<string, CohoProperty[]>();
    for (const property of cohoProperties) {
      const location = property.location?.trim() || 'Other locations';
      const group = grouped.get(location) ?? [];
      group.push(property);
      grouped.set(location, group);
    }
    return Array.from(grouped.entries())
      .map(([location, properties]) => ({ location, properties: properties.sort((a, b) => (a.name ?? a.reference ?? '').localeCompare(b.name ?? b.reference ?? '')) }))
      .sort((a, b) => a.location.localeCompare(b.location));
  }, [cohoProperties]);
  const selectedProperty = branch === 'all' ? undefined : cohoProperties.find(property => property.reference === branch);
  const selectedPropertyName = selectedProperty?.name ?? 'All properties';
  const selectedPropertyReference = branch === 'all' ? undefined : branch;
  useEffect(() => { try { localStorage.removeItem(LEGACY_DEMO_STORAGE); } catch { /* storage unavailable */ } }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2600); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { setSideOpen(false); }, [path]);
  const nav = <>{navGroups.map(group => <div className="nav-group" key={group.label}><div className="nav-label">{group.label}</div>{group.items.map(([href, label, Icon]) => <Link href={href} key={href} className={'nav-link ' + (path === href || path.startsWith(`${href}/`) ? 'active' : '')} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={15} /><span>{label}</span></Link>)}</div>)}</>;
  const term = global.trim().toLowerCase();
  const globalResults = term
    ? cohoProperties
      .filter(property => `${property.name ?? ''} ${property.reference ?? ''} ${property.location ?? ''}`.toLowerCase().includes(term))
      .slice(0, 6)
    : [];
  const chooseProperty = (property: CohoProperty) => {
    if (!property.reference) return;
    setBranch(property.reference);
    setGlobal('');
    setToast(`Showing ${property.name || property.reference}`);
  };
  return <div className="app-shell">
    {sideOpen && <div className="mobile-overlay show" onClick={() => setSideOpen(false)} />}
    <aside className={'sidebar ' + (sideOpen ? 'open' : '')}><Link href="/dashboard" className="brand" data-testid="link-brand"><span className="brand-mark"><House size={17} /></span><span className="brand-name">Hinkley Homes<span className="brand-sub">Property operations</span></span></Link>
      <div className="nav-scroll">{nav}</div><div className="side-foot"><div className="avatar">{profileInitials}</div><div className="side-profile-copy"><strong>{profileName}</strong><small>Staff account</small></div><button className="icon-btn" title="Sign out" aria-label="Sign out" onClick={() => void signOut({ redirectUrl: basePath || '/' })} data-testid="button-signout-sidebar"><LogOut size={14} /></button></div>
    </aside>
    <div className="main-area">
      <header className="topbar"><button className="icon-btn mobile-toggle" onClick={() => setSideOpen(true)} aria-label="Open navigation"><Menu size={19} /></button>
        <div className="global-search"><Search size={15} /><input value={global} onChange={e => setGlobal(e.target.value)} placeholder="Search COHO properties…" aria-label="Search properties" data-testid="input-global-search" />{global && <button className="icon-btn" onClick={() => setGlobal('')} aria-label="Clear search"><X size={13} /></button>}</div>
        <div className="top-spacer" /><select className="top-branch" value={branch} onChange={e => setBranch(e.target.value)} aria-label="Location and property"><option value="all">All properties</option>{cohoLocationGroups.map(group => <optgroup key={group.location} label={group.location}>{group.properties.map(property => <option key={property.reference ?? property.name} value={property.reference ?? ''} disabled={!property.reference}>{property.name || property.reference || 'Unnamed property'}</option>)}</optgroup>)}{cohoProperties.length === 0 && <option value="unavailable" disabled>{cohoStatusQuery.isLoading || cohoPropertiesQuery.isLoading ? 'Loading COHO properties…' : cohoConfigured ? 'No COHO properties available' : 'COHO key needed'}</option>}</select><div className="top-profile" data-testid="user-profile-badge"><div className="avatar">{profileInitials}</div><div className="top-profile-copy"><strong>{profileName}</strong><span>{profileEmail}</span></div><button className="top-signout" type="button" title="Sign out" aria-label="Sign out" onClick={() => void signOut({ redirectUrl: basePath || '/' })} data-testid="button-signout"><LogOut size={14} /></button></div>
        {term && <div style={{ position: 'absolute', top: 52, left: 62, width: 390, maxWidth: 'calc(100vw - 85px)', background: '#fff', border: '1px solid #e4e9ed', borderRadius: 8, boxShadow: '0 12px 34px #1b29361c', zIndex: 50, padding: 5 }}>
          {globalResults.length ? globalResults.map(property => <button key={property.reference ?? property.name} type="button" onClick={() => chooseProperty(property)} disabled={!property.reference} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px', background: 'none', border: 0, color: '#344256', borderRadius: 5, cursor: 'pointer', font: 'inherit' }}><b style={{ fontSize: 13 }}>{property.name || property.reference}</b><span style={{ display: 'block', fontSize: 12, color: '#8793a0', marginTop: 3 }}>{[property.location, `${property.rooms?.length ?? 0} rooms`].filter(Boolean).join(' · ')}</span></button>)
            : <div style={{ padding: '9px 10px', fontSize: 12, color: '#8793a0' }}>{cohoConfigured ? 'No COHO properties match.' : 'COHO is not configured.'}</div>}
        </div>}
      </header>
      <main className="content">
        <Switch>
          <Route path="/dashboard"><Overview profileName={profileName} configured={cohoConfigured} statusLoading={cohoStatusQuery.isLoading} properties={selectedProperty ? [selectedProperty] : cohoProperties} propertiesLoading={cohoPropertiesQuery.isLoading} propertyName={selectedPropertyName} propertyReference={selectedPropertyReference} /></Route>
          <Route path="/calendar"><CalendarPage selectedPropertyReference={selectedPropertyReference} /></Route>
          <Route path="/actions"><ActionsPage selectedPropertyReference={selectedPropertyReference} /></Route>
          <Route path="/occupancy"><OccupancyPage selectedPropertyReference={selectedPropertyReference} /></Route>
          <Route path="/maintenance" component={CohoMaintenancePage} />
          <Route path="/properties"><PropertiesPage /></Route>
          <Route path="/properties/:id">{(params) => <PropertyDetailPage id={decodeURIComponent(params.id)} />}</Route>
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
    {toast && <div className="toast-msg" role="status">{toast}</div>}
  </div>;
}

function PageHeader({ title, subtitle, eyebrow, children }: { title: string; subtitle: string; eyebrow?: string; children?: ReactNode }) { return <div className="page-head"><div><div className="eyebrow">{eyebrow || 'Hinkley Homes · Operations'}</div><h1 className="page-title">{title}</h1><p className="page-sub">{subtitle}</p></div><div className="head-actions">{children}</div></div>; }
function SmallMetric({ label, value, foot, icon }: { label: string; value: string; foot: string; icon: ReactNode }) { return <div className="panel metric-small"><div className="metric-top">{label}<span style={{ color: '#559582' }}>{icon}</span></div><div className="metric-value">{value}</div><div className="metric-foot">{foot}</div></div>; }

function Overview({ profileName, configured, statusLoading, properties, propertiesLoading, propertyName, propertyReference }: { profileName: string; configured: boolean; statusLoading: boolean; properties: CohoProperty[]; propertiesLoading: boolean; propertyName: string; propertyReference?: string }) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekEnd = new Date(todayStart.getTime() + 7 * 86_400_000);
  const calendarParams = useMemo(() => ({ fromDate: todayStart.toISOString() }), [todayStart.getTime()]);
  const calendarQuery = useListCohoCalendar(calendarParams, { query: { queryKey: getListCohoCalendarQueryKey(calendarParams), enabled: configured } });
  const upcoming = (calendarQuery.data?.items ?? [])
    .filter(entry => (!propertyReference || entry.propertyReference === propertyReference) && new Date(entry.entryDate) < weekEnd)
    .slice(0, 8);
  const moneyQuery = useGetMoneyOverview({ query: { queryKey: getGetMoneyOverviewQueryKey(), refetchInterval: 5 * 60_000 } });
  const coho = moneyQuery.data?.coho;
  const cohoMoney = coho && !coho.error ? coho : undefined;
  const arrearsInScope = (cohoMoney?.arrears ?? []).filter(item => !propertyReference || item.propertyReference === propertyReference);
  const collectedShare = cohoMoney?.dueThisMonth ? Math.round((cohoMoney.paidThisMonth / cohoMoney.dueThisMonth) * 100) : null;
  const moneyValue = (value?: number) => moneyQuery.isLoading ? '…' : value === undefined ? '—' : formatPounds(value);
  const pending = statusLoading || (configured && propertiesLoading);
  const show = (value: number) => pending ? '…' : configured ? value.toString() : '—';
  return <>
    <div className="dashboard-hero"><PageHeader title="Operations overview" subtitle={`${propertyName} · ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`} eyebrow={`${greeting(now)}, ${profileName.split(' ')[0]}`} /></div>
    <div className="metric-row2" style={{ gridTemplateColumns: 'repeat(4,minmax(0,1fr))' }}>
      <SmallMetric label="COHO connection" value={statusLoading ? '…' : configured ? 'Connected' : 'Not set up'} foot={configured ? 'Public API 1.1' : 'Add the COHO API key'} icon={<PlugZap size={14} />} />
      <SmallMetric label="Properties" value={show(properties.length)} foot="In COHO" icon={<Building2 size={14} />} />
      <SmallMetric label="Rent collected" value={moneyValue(cohoMoney?.paidThisMonth)} foot={cohoMoney ? `of ${formatPounds(cohoMoney.dueThisMonth)} due this month${collectedShare === null ? '' : ` (${collectedShare}%)`}${propertyReference ? ' · all properties' : ''}` : 'This month, from COHO'} icon={<PoundSterling size={14} />} />
      <SmallMetric label="Overdue rent" value={propertyReference ? moneyValue(cohoMoney ? arrearsInScope.reduce((sum, item) => sum + item.outstanding, 0) : undefined) : moneyValue(cohoMoney?.overdue)} foot={cohoMoney ? (arrearsInScope.length ? `${arrearsInScope.length} ${arrearsInScope.length === 1 ? 'tenancy' : 'tenancies'} in arrears` : 'No arrears') : 'From COHO credit control'} icon={<AlertTriangle size={14} />} />
    </div>
    <MoneyPanels data={moneyQuery.data} loading={moneyQuery.isLoading} failed={moneyQuery.isError} propertyReference={propertyReference} />
    <section className="panel arrival-panel"><div className="panel-head"><div><div className="panel-title">Coming up in COHO</div><div className="panel-caption">Tenancies, viewings, maintenance and actions in the next 7 days</div></div><Link href="/calendar" className="button" style={{ textDecoration: 'none' }}>Open calendar <ArrowUpRight size={13} /></Link></div>
      {!configured ? <div className="empty-state"><PlugZap size={21} /><h3>COHO is not configured</h3><p>Add the COHO API key to see live activity.</p></div>
        : calendarQuery.isLoading ? <div className="empty-state"><CalendarDays size={21} /><h3>Loading COHO activity…</h3></div>
          : calendarQuery.isError ? <div className="empty-state"><CalendarDays size={21} /><h3>COHO activity could not be loaded</h3><p>Try again in a moment.</p></div>
            : upcoming.length ? <div className="arrival-list">{upcoming.map(entry => <div className="arrival-row" key={entry.id}>
              <div className="guest-cell"><span className="guest-initial">{initials(entry.title || entry.entryType || 'C')}</span><div><strong>{entry.title || entry.entryType}</strong><span className="secondary-text">{entry.personName || entry.entryType}</span></div></div>
              <div><span className="secondary-text">Property</span><strong>{entry.propertyName || entry.propertyReference || '—'}</strong></div>
              <div><span className="secondary-text">When</span><strong>{new Date(entry.entryDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</strong></div>
              <span className="status upcoming">{entry.entryType || entry.source}</span>
            </div>)}</div>
              : <div className="empty-state"><CalendarDays size={21} /><h3>Nothing scheduled this week</h3><p>COHO has no activity for {propertyName.toLowerCase() === 'all properties' ? 'any property' : propertyName} in the next 7 days.</p></div>}
    </section>
    <section className="panel" style={{ padding: 15, marginTop: 13, display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <div><div className="panel-title">Maintenance</div><div className="panel-caption">Report, update and complete COHO maintenance issues</div></div>
      <Link href="/maintenance" className="button primary" style={{ textDecoration: 'none' }}><Wrench size={13} /> Open maintenance</Link>
    </section>
  </>;
}

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY.');
const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: { logoPlacement: 'inside' as const, logoLinkUrl: basePath || '/', logoImageUrl: `${window.location.origin}${basePath}/logo.svg` },
  variables: { colorPrimary: '#267966', colorForeground: '#e8edf5', colorMutedForeground: '#99a6ba', colorDanger: '#ef8e91', colorBackground: '#172337', colorInput: '#111b2b', colorInputForeground: '#edf2f7', colorNeutral: '#34425a', fontFamily: '"DM Sans", sans-serif', fontSize: '0.9375rem', borderRadius: '0.7rem' }
};
function HomeRedirect() { const { isLoaded, isSignedIn } = useAuth(); if (!isLoaded) return <AuthLoadingPage />; return isSignedIn ? <Redirect to="/dashboard" /> : <AuthLandingPage />; }
function SignedOutOnly({ children }: { children: ReactNode }) { const { isLoaded, isSignedIn } = useAuth(); if (!isLoaded) return <AuthLoadingPage />; return isSignedIn ? <Redirect to="/dashboard" /> : <>{children}</>; }
function ProtectedCRM() { const { isLoaded, isSignedIn } = useAuth(); const { user, isLoaded: userLoaded } = useUser(); const { signOut } = useClerk(); if (!isLoaded || !userLoaded) return <AuthLoadingPage />; if (!isSignedIn) return <Redirect to="/sign-in" />; const email = user?.primaryEmailAddress?.emailAddress ?? ''; if (!isAllowedStaffEmail(email)) return <AccessRestrictedPage onSignOut={() => void signOut({ redirectUrl: basePath || '/' })} />; return <AppShell />; }
function ClerkQueryClientCacheInvalidator() { const { addListener } = useClerk(); const client = useRef<string | null | undefined>(undefined); useEffect(() => addListener(({ user }) => { const userId = user?.id ?? null; if (client.current !== undefined && client.current !== userId) queryClient.clear(); client.current = userId; }), []); return null; }
function RoutedErrorBoundary({ children }: { children: ReactNode }) { const [location] = useLocation(); return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>; }
function Router() { return <RoutedErrorBoundary><Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={() => <SignedOutOnly><SignInPage /></SignedOutOnly>} /><Route path="/sign-up/*?" component={() => <SignedOutOnly><SignUpPage /></SignedOutOnly>} /><Route path="/dashboard" component={ProtectedCRM} /><Route path="/calendar" component={ProtectedCRM} /><Route path="/actions" component={ProtectedCRM} /><Route path="/occupancy" component={ProtectedCRM} /><Route path="/maintenance" component={ProtectedCRM} /><Route path="/properties" component={ProtectedCRM} /><Route path="/properties/:id" component={ProtectedCRM} /><Route path="/widget" component={ListingsWidget} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>; }
function ClerkApp() { const [, setLocation] = useLocation(); function stripBase(path: string) { return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path; } return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to access your Hinkley Homes staff account' } }, signUp: { start: { title: 'Create your account', subtitle: 'Use your Hinkley Homes company email to register' } } }} routerPush={to => setLocation(stripBase(to))} routerReplace={to => setLocation(stripBase(to), { replace: true })}><QueryClientProvider client={queryClient}><TooltipProvider><ClerkQueryClientCacheInvalidator /><Router /><Toaster /></TooltipProvider></QueryClientProvider></ClerkProvider>; }
function App() { return <WouterRouter base={basePath}><ClerkApp /></WouterRouter>; }
export default App;
