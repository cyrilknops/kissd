import { useSearchParams } from 'react-router-dom';
import HistoryPanel from '../components/HistoryPanel';

export default function Metrics() {
  const [params, setParams] = useSearchParams();
  const target = params.get('target') || 'host';
  return <>
    <div className="page-head"><div><h1>Metrics</h1><p>Resource trends and availability, collected even when the panel is closed.</p></div></div>
    <HistoryPanel target={target} onTargetChange={(value) => setParams({ target: value })} />
  </>;
}
