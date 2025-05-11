import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { createClient } from '@supabase/supabase-js';
import { SessionContextProvider, sessionContextProvider } from '@supabase/auth-helpers-react';

const supabase = createClient(
  'https://rglijymimjsgcpdunwtu.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJnbGlqeW1pbWpzZ2NwZHVud3R1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDIxNjI2NzEsImV4cCI6MjA1NzczODY3MX0.zF15x2k8dhLvJiITyRPK493HaCpqMhSl41tJkDRGvQI'
);

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <SessionContextProvider supabaseClient={supabase}>
      <App />
    </SessionContextProvider>
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
