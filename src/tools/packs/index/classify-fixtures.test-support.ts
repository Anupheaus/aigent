import type { FileTag } from './index-types.js';

/** A hand-labelled file: its path, its text and every tag a careful reader would give it. */
export interface LabelledFile {
  path: string;
  text: string;
  tags: FileTag[];
}

const js = (...lines: string[]): string => `${lines.join('\n')}\n`;

/**
 * Hand-labelled fixtures in styles the bench generator does not use (default exports, express-style handlers, hooks
 * with context, class utilities, MUI and styled tokens, knex and prisma calls), so the per-tag precision and recall
 * thresholds measure the heuristics, not the generator.
 */
export const LABELLED_FILES: readonly LabelledFile[] = [
  { path: 'src/components/Header.tsx', tags: ['react-component'], text: js("import React from 'react';", '', 'export default function Header({ title }: { title: string }) {', '  return <header className="top">{title}</header>;', '}') },
  { path: 'src/components/Avatar.jsx', tags: ['react-component'], text: js('export const Avatar = ({ src }) => (', '  <img src={src} alt="" />', ');') },
  { path: 'src/components/ProfileCard.tsx', tags: ['react-component', 'renders-customer-data'], text: js('export function ProfileCard({ user }: Props) {', '  return (', '    <div>', '      <h2>{user.fullName}</h2>', '      <a href={`mailto:${user.email}`}>{user.email}</a>', '    </div>', '  );', '}') },
  { path: 'src/components/ShippingLabel.tsx', tags: ['react-component', 'renders-customer-data'], text: js('export const ShippingLabel = ({ order }: Props) => (', '  <pre>{order.customer.postalAddress}</pre>', ');') },
  { path: 'src/components/ContactRow.tsx', tags: ['react-component', 'renders-customer-data'], text: js('export function ContactRow({ contact }: Props) {', '  return <tr><td>{contact.phoneNumber}</td></tr>;', '}') },
  { path: 'src/components/PriceTag.tsx', tags: ['react-component'], text: js('export function PriceTag({ cents }: { cents: number }) {', '  return <span>{(cents / 100).toFixed(2)}</span>;', '}') },
  { path: 'src/components/OrderTable.tsx', tags: ['react-component'], text: js('export function OrderTable({ rows }: Props) {', '  return (', '    <table>{rows.map(row => <tr key={row.customerId}><td>{row.total}</td></tr>)}</table>', '  );', '}') },
  { path: 'src/components/Header.test.tsx', tags: ['test'], text: js("import { render } from '@testing-library/react';", "it('renders', () => { render(<Header title=\"x\" />); });") },
  { path: 'src/components/Header.stories.tsx', tags: ['story'], text: js("export default { title: 'Header' };", 'export const Basic = () => <Header title="Hello" />;') },
  { path: 'src/components/__mocks__/Avatar.tsx', tags: ['mock'], text: js('export const Avatar = () => <div />;') },
  { path: 'src/lib/html.ts', tags: [], text: js('export function Badge(text: string): string {', "  return '<span class=\"badge\">' + text + '</span>';", '}') },
  { path: 'src/lib/ButtonGroup.ts', tags: [], text: js('export class ButtonGroup {', '  static gap = 4;', '}') },
  { path: 'src/hooks/useToggle.ts', tags: ['hook'], text: js("import { useState } from 'react';", 'export function useToggle(initial = false) {', '  const [on, setOn] = useState(initial);', '  return [on, () => setOn(!on)] as const;', '}') },
  { path: 'src/hooks/useSession.ts', tags: ['hook'], text: js("import { useContext } from 'react';", 'export const useSession = () => useContext(SessionContext);') },
  { path: 'src/context/SessionContext.tsx', tags: ['provider', 'react-component'], text: js("import { createContext } from 'react';", 'export const SessionContext = createContext(null);', 'export function SessionProvider({ children }: Props) {', '  return <SessionContext.Provider value={null}>{children}</SessionContext.Provider>;', '}') },
  { path: 'src/context/FlagsProvider.tsx', tags: ['provider', 'react-component'], text: js('export function FlagsProvider({ children }: Props) {', '  return <Flags.Provider value={flags}>{children}</Flags.Provider>;', '}') },
  { path: 'src/hocs/withLogger.tsx', tags: [], text: js('export function withLogger(Component) {', '  return function Logged(props) {', '    return <Component {...props} />;', '  };', '}') },
  { path: 'src/styles/theme.ts', tags: ['theme-definition'], text: js("import { createTheme } from '@mui/material/styles';", 'export const theme = createTheme({ palette: { mode: \'light\' } });') },
  { path: 'src/styles/palette.ts', tags: ['theme-definition'], text: js("import type { PaletteTokens } from './types';", "export const palette: PaletteTokens = { primary: '#123456' };") },
  { path: 'src/styles/brandTheme.ts', tags: ['theme-definition'], text: js("export const brandTheme: DefaultTheme = { colors: { ink: '#000' } };") },
  { path: 'src/styles/index.ts', tags: ['theme-reexport'], text: js("export { theme } from './theme';") },
  { path: 'src/styles/themeHelpers.ts', tags: [], text: js('// Helpers that read values from the theme.', 'export function spacing(theme: { unit: number }, n: number): number {', '  return theme.unit * n;', '}') },
  { path: 'src/api/routes.ts', tags: ['api-route'], text: js("import { Router } from 'express';", "import { getUser, deleteAccount } from './users';", 'export const router = Router();', "router.get('/users/:id', getUser);", "router.delete('/users/:id', deleteAccount);") },
  { path: 'src/api/legacyRoutes.ts', tags: [], text: js('export const old = Router();', "// old.get('/v1/users', listUsers);") },
  { path: 'src/api/users.ts', tags: ['api-handler', 'data-access'], text: js('export async function getUser(req: Request, res: Response) {', "  const user = await db.query('select * from users where id = $1', [req.params.id]);", '  res.json(user);', '}') },
  { path: 'src/api/accountDeletion.ts', tags: ['api-handler', 'gdpr-deletion'], text: js("import { eraseUserData } from '../privacy/erase';", 'export async function deleteAccount(req: Request, res: Response) {', '  await eraseUserData(req.params.id);', '  res.status(204).end();', '}') },
  { path: 'src/api/consent.ts', tags: ['api-handler', 'gdpr-consent'], text: js('export const updateConsent = async (req, res) => {', '  await consents.save(req.body);', '  res.sendStatus(204);', '};') },
  { path: 'src/api/dataExport.ts', tags: ['api-handler', 'gdpr-export'], text: js('export async function exportHandler(request: Request) {', '  return buildUserDataExport(request.params.id);', '}') },
  { path: 'src/api/cleanup.ts', tags: ['api-handler', 'gdpr-retention'], text: js('export async function cleanupHandler(request: Request) {', '  await purgeExpiredSessions(RETENTION_DAYS);', '}') },
  { path: 'src/api/reports.ts', tags: ['api-handler'], text: js('// TODO(GDPR): consent check for reports', 'export async function reportsHandler(request: Request) {', "  return { body: 'ok' };", '}') },
  { path: 'src/api/ordersExport.ts', tags: ['api-handler', 'data-access'], text: js('export async function ordersCsv(req: Request) {', "  return knex.raw('select * from orders');", '}') },
  { path: 'src/privacy/erase.ts', tags: [], text: js('export async function eraseUserData(id: string): Promise<void> {', '  await queue.push({ kind: \'erase\', id });', '}') },
  { path: 'src/data/userRepo.ts', tags: ['data-access'], text: js('export async function findUser(id: string) {', '  return prisma.query(`select * from users where id = ${id}`);', '}') },
  { path: 'src/models/user.ts', tags: ['schema', 'personal-data-fields'], text: js('export interface User {', '  id: string;', '  email: string;', '  dateOfBirth?: Date;', '}') },
  { path: 'src/models/address.ts', tags: ['schema', 'personal-data-fields'], text: js("import { z } from 'zod';", 'export const AddressSchema = z.object({', '  streetAddress: z.string(),', '  postcode: z.string(),', '});') },
  { path: 'src/models/settings.ts', tags: ['schema'], text: js('export interface Settings {', '  emailTemplateId: string;', '  phoneticSearch: boolean;', '}') },
  { path: 'src/models/order.ts', tags: ['schema'], text: js('export type Order = {', '  id: string;', '  // email: string; moved to User', '  total: number;', '};') },
  { path: 'src/util/format.ts', tags: [], text: js('export function formatName(first: string, last: string): string {', '  return `${last}, ${first}`;', '}') },
  { path: 'src/util/math.ts', tags: [], text: js('export const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));') },
  { path: 'package.json', tags: ['config'], text: js('{ "name": "app" }') },
  { path: 'tsconfig.json', tags: ['config'], text: js('{ "compilerOptions": {} }') },
  { path: 'config/app.yaml', tags: ['config'], text: js('port: 80') },
  { path: 'README.md', tags: [], text: js('# App', 'Uses createTheme and router.get for docs only.') },
  { path: 'src/server/app.ts', tags: [], text: js("import { router } from '../api/routes';", 'app.use(router);') },
];
