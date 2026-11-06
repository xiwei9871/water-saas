import { useEffect, useRef } from 'react';

/**
 * M8 全系统实时置顶：订阅 /events/stream SSE——本租户任何写操作成功后
 * 推送 {entity}；匹配域时防抖 400ms 触发重载，列表重新拉取后新记录自然
 * 置顶（各列表均按 createdAt desc）。entities 为空则任何变更都刷新。
 */
export function useLiveRefresh(entities: string[] | string | undefined, onChange: () => void) {
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  const ents = entities === undefined ? null
    : new Set(Array.isArray(entities) ? entities : [entities]);
  const entRef = useRef(ents);
  entRef.current = ents;
  useEffect(() => {
    const token = localStorage.getItem('water-saas.accessToken');
    if (!token) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource(
      `/api/events/stream?access_token=${encodeURIComponent(token)}`,
    );
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { entity?: string };
        if (entRef.current && d.entity && !entRef.current.has(d.entity)) return;
      } catch { /* 非 JSON 心跳也刷 */ }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cbRef.current(), 400);
    };
    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, []);
}
