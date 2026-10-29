import { useEffect, useRef } from 'react';

/**
 * 1028v2 任务实时置顶：订阅 /tasks/events SSE，任务创建/指派/领取/
 * 完成/取消时回调（防抖 300ms 合并双发与密集变更）。
 * EventSource 无法带 Authorization 头，走 ?access_token=。
 */
export function useTaskStream(onChange: () => void) {
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  useEffect(() => {
    const token = localStorage.getItem('water-saas.accessToken');
    if (!token) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource(
      `/api/tasks/events?access_token=${encodeURIComponent(token)}`,
    );
    es.onmessage = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cbRef.current(), 300);
    };
    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, []);
}
