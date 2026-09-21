import { useEffect } from 'react';
import { GamePage } from './components/GamePage';
import { useGameStore } from './store/useGameStore';

export default function App() {
  const init = useGameStore((state) => state.init);
  const clearNotice = useGameStore((state) => state.clearNotice);

  useEffect(() => {
    init().catch((error) => console.error('文明馆初始化失败', error));
  }, [init]);

  useEffect(() => {
    const timer = window.setTimeout(clearNotice, 6000);
    return () => window.clearTimeout(timer);
  }, [clearNotice]);

  return <GamePage />;
}
