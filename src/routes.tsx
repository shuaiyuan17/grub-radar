import type { RouteObject } from 'react-router';
import { AuthGate } from './components/AuthGate';
import { Layout } from './pages/Layout';
import { ListPage } from './pages/ListPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlacePage } from './pages/PlacePage';
import { RadarPage } from './pages/RadarPage';
import { AddSearchPage } from './pages/AddSearchPage';
import { AddSpotPage, EditSpotPage } from './pages/SpotFormPage';

export const routes: RouteObject[] = [
  {
    // signed out: the login wall on every URL
    element: <AuthGate />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <ListPage /> },
          // search Apple Maps first; by hand is the fallback
          { path: 'add', element: <AddSearchPage /> },
          { path: 'add/manual', element: <AddSpotPage /> },
          { path: 'place/:id', element: <PlacePage /> },
          { path: 'place/:id/edit', element: <EditSpotPage /> },
          { path: 'radar', element: <RadarPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
