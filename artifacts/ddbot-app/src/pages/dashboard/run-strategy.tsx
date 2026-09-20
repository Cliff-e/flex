import BotMonitorDropdown from '@/components/bot-monitor-dropdown';
import TradeAnimation from '@/components/trade-animation';

const RunStrategy = () => (
    <div className='toolbar__section' data-testid='dt_run_strategy'>
        <TradeAnimation className='toolbar__animation' />
        {/* Tiny collapsed bot monitor: [Run/Stop] [contract status] [chevron]. */}
        <BotMonitorDropdown variant='status-bar' />
    </div>
);

export default RunStrategy;
