import {useMemo, useState} from 'react';
import {Button} from './components/ui/button';
import {Checkbox} from './components/ui/checkbox';
import {Input} from './components/ui/input';

type Status = 'Active' | 'Review' | 'Draft';
type Row = {id: number; name: string; owner: string; status: Status; updated: string};

const initialRows: Row[] = [
  {id: 1, name: 'Website redesign', owner: 'Maya Chen', status: 'Active', updated: 'Today, 9:41 AM'},
  {id: 2, name: 'Q3 campaign', owner: 'Jon Bell', status: 'Review', updated: 'Yesterday'},
  {id: 3, name: 'Customer research', owner: 'Sofia Diaz', status: 'Active', updated: 'Aug 12'},
  {id: 4, name: 'Mobile onboarding', owner: 'Alex Kim', status: 'Draft', updated: 'Aug 10'},
  {id: 5, name: 'Design system', owner: 'Maya Chen', status: 'Active', updated: 'Aug 8'},
];

const Icon = ({name}: {name: string}) => {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    table: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/><path d="M10 11v6M14 11v6"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
};

export default function App() {
  const [rows, setRows] = useState(initialRows);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const visible = useMemo(() => rows.filter(row => `${row.name} ${row.owner} ${row.status}`.toLowerCase().includes(query.toLowerCase())), [rows, query]);

  const addRow = () => setRows(current => [...current, {id: Date.now(), name: 'Untitled project', owner: 'Unassigned', status: 'Draft', updated: 'Just now'}]);
  const removeSelected = () => { setRows(rows.filter(row => !selected.includes(row.id))); setSelected([]); };
  const update = (id: number, key: keyof Row, value: string) => setRows(rows.map(row => row.id === id ? {...row, [key]: value} : row));

  return <div className="app-shell">
    <aside>
      <div className="brand"><span className="brand-mark">ix</span><strong>ixtable</strong></div>
      <nav>
        <button className="nav-item"><Icon name="grid"/>Overview</button>
        <button className="nav-item active"><Icon name="table"/>Projects<span>{rows.length}</span></button>
      </nav>
      <div className="aside-bottom">
        <div className="avatar">MC</div><div><strong>Maya Chen</strong><small>maya@example.com</small></div><button className="icon-button"><Icon name="more"/></button>
      </div>
    </aside>
    <main>
      <header><div><p className="eyebrow">WORKSPACE / PROJECTS</p><h1>Projects</h1><p className="subtitle">Organize and track work across your team.</p></div><button className="primary" onClick={addRow}><Icon name="plus"/>New project</button></header>
      <section className="table-card" data-testid="projects-table">
        <div className="toolbar">
          <div className="search"><Icon name="search"/><Input aria-label="Search projects" placeholder="Search projects..." value={query} onChange={e => setQuery(e.target.value)}/><kbd>⌘ K</kbd></div>
          {selected.length > 0 && <Button variant="destructive" size="sm" className="danger" onClick={removeSelected}><Icon name="trash"/>Delete {selected.length}</Button>}
          <button className="filter">All projects <span>⌄</span></button>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th className="check"><Checkbox aria-label="Select all" checked={visible.length > 0 && visible.every(r => selected.includes(r.id))} onCheckedChange={checked => setSelected(checked ? visible.map(r => r.id) : [])}/></th><th>Project</th><th>Owner</th><th>Status</th><th>Last updated</th><th></th></tr></thead>
          <tbody>{visible.map(row => <tr key={row.id} className={selected.includes(row.id) ? 'selected' : ''}>
            <td className="check"><Checkbox aria-label={`Select ${row.name}`} checked={selected.includes(row.id)} onCheckedChange={() => setSelected(s => s.includes(row.id) ? s.filter(id => id !== row.id) : [...s, row.id])}/></td>
            <td><input className="cell-input project-name" value={row.name} onChange={e => update(row.id, 'name', e.target.value)}/></td>
            <td><input className="cell-input" value={row.owner} onChange={e => update(row.id, 'owner', e.target.value)}/></td>
            <td><select className={`status ${row.status.toLowerCase()}`} value={row.status} onChange={e => update(row.id, 'status', e.target.value)}><option>Active</option><option>Review</option><option>Draft</option></select></td>
            <td className="muted">{row.updated}</td><td><button className="icon-button"><Icon name="more"/></button></td>
          </tr>)}</tbody>
        </table></div>
        {visible.length === 0 && <div className="empty"><strong>No projects found</strong><span>Try a different search.</span></div>}
        <footer><span>{visible.length} of {rows.length} projects</span><span>Changes are saved automatically</span></footer>
      </section>
    </main>
  </div>;
}
