import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/layout/Layout';
import { Dashboard } from './pages/Dashboard';
import { Nodes } from './pages/Nodes';
import { Mappings } from './pages/Mappings';
import { Files } from './pages/Files';
import { Jobs } from './pages/Jobs';
import { Presets } from './pages/Presets';
import { Settings } from './pages/Settings';
import { Library } from './pages/Library';

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/nodes" element={<Nodes />} />
        <Route path="/mappings" element={<Mappings />} />
        <Route path="/files" element={<Files />} />
        <Route path="/library" element={<Library />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/presets" element={<Presets />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Layout>
  );
}

export default App;
