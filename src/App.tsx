import { Routes, Route } from 'react-router-dom';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { ToolWorkspace } from '@/components/layout/ToolWorkspace';

export default function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/tool/:toolId" element={<ToolWorkspace />} />
      </Routes>
    </div>
  );
}
