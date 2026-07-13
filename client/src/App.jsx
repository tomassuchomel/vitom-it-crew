import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { TeamProvider } from './teams.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Timeline from './pages/Timeline.jsx';
import ProjectsList from './pages/ProjectsList.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';
import TimeTracking from './pages/TimeTracking.jsx';
import Reports from './pages/Reports.jsx';
import TeamPage from './pages/Team.jsx';
import MyTasks from './pages/MyTasks.jsx';
import Review from './pages/Review.jsx';
import NeedsFix from './pages/NeedsFix.jsx';
import Questions from './pages/Questions.jsx';
import AIPage from './pages/AIPage.jsx';
import Profile from './pages/Profile.jsx';
import Admin from './pages/Admin.jsx';
import Scoreboard from './pages/Scoreboard.jsx';
import Notes from './pages/Notes.jsx';
import EmailPage from './pages/Email.jsx';
import AnsweredQuestions from './pages/AnsweredQuestions.jsx';
import DueChangeRequests from './pages/DueChangeRequests.jsx';
import FindTasks from './pages/FindTasks.jsx';
import Meetings from './pages/Meetings.jsx';
import Napadnik from './pages/Napadnik.jsx';
import NapadnikForm from './pages/NapadnikForm.jsx';
import UpdatePrompt from './components/UpdatePrompt.jsx';

function ProtectedRoutes() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-8 text-slate-500">Načítám…</div>;
  if (!user) return <Navigate to="/login" replace />;

  // Force password change při prvním přihlášení (nebo po resetu adminem).
  // Uživatele přesměrujeme na /profile, kde mu sekce "Heslo" zobrazí povinnou změnu.
  if (user.must_change_password && location.pathname !== '/profile') {
    return <Navigate to="/profile" replace />;
  }

  return (
    <Layout>
      {user.must_change_password && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 px-6 py-3 text-sm">
          ⚠️ Máš nastavené výchozí heslo. Pro pokračování si níže nastav vlastní.
        </div>
      )}
      <Routes>
        <Route path="/" element={<Timeline />} />
        <Route path="/projects" element={<ProjectsList />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/my-tasks" element={<MyTasks />} />
        <Route path="/review" element={<Review />} />
        <Route path="/needs-fix" element={<NeedsFix />} />
        <Route path="/notes" element={<Notes />} />
        <Route path="/napadnik" element={<Napadnik />} />
        <Route path="/email" element={<EmailPage />} />
        <Route path="/questions" element={<Questions />} />
        <Route path="/answers" element={<AnsweredQuestions />} />
        <Route path="/due-requests" element={<DueChangeRequests />} />
        <Route path="/find-tasks" element={<FindTasks />} />
        <Route path="/porady" element={<Meetings />} />
        <Route path="/time" element={<TimeTracking />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/ai" element={<AIPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/scoreboard" element={<Scoreboard />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <TeamProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* Veřejný formulář Nápadníku — bez přihlášení, samostatná stránka. */}
          <Route path="/napadnik-form" element={<NapadnikForm />} />
          <Route path="/*" element={<ProtectedRoutes />} />
        </Routes>
        {/* PWA — když SW najde novou verzi, ukáže toast „Aktualizovat". */}
        <UpdatePrompt />
      </TeamProvider>
    </AuthProvider>
  );
}
