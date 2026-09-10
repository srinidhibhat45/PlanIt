import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/views.css';
import './styles/plan.css';
import Root from './Root';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
