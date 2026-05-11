import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Timeline from './pages/Timeline.jsx';
import ProjectsList from './pages/ProjectsList.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';
import TimeTracking from './pages/TimeTracking.jsx';
import Reports from './pages/Reports.jsx';
import TeamPage from './pages/Team.jsx';
import MyTasks from './pages/MyTasks.jsx';
import Questions from './pages/Questions.jsx';
import AIPage from './pages/AIPage.jsx';

function ProtectedRoutes() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-slate-500">Načítám…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Timeline />} />
        <Route path="/projects" element={<ProjectsList />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/my-tasks" element={<MyTasks />} />
        <Route path="/questions" element={<Questions />} />
        <Route path="/time" element={<TimeTracking />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/ai" element={<AIPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<ProtectedRoutes />} />
      </Routes>
    </AuthProvider>
  );
}
