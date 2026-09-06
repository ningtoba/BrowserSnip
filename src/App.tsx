import { Routes, Route } from 'react-router-dom';
import { MotionConfig } from 'framer-motion';
import { AppLayout } from '@/components/layout/AppLayout';
import { Landing } from '@/components/landing/Landing';
import { VideoDashboard } from '@/components/dashboard/VideoDashboard';
import { PdfDashboard } from '@/components/dashboard/PdfDashboard';
import { ToolWorkspace } from '@/components/layout/ToolWorkspace';

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-cream text-ink font-body">
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Landing />} />
            <Route path="/video" element={<VideoDashboard />} />
            <Route path="/pdf" element={<PdfDashboard />} />
            <Route path="/tool/:toolId" element={<ToolWorkspace />} />
          </Route>
        </Routes>
      </div>
    </MotionConfig>
  );
}
