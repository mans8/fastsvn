import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import '@/src/styles/fastsvn.css';
import App from './App';

// 不用 StrictMode：桌面应用不需要开发期的双调用，且它会让状态请求与
// 检出轮询各跑两遍，反而干扰"缓存命中"这类真实行为。
createRoot(document.getElementById('root')!).render(<App />);
