import { observer } from 'mobx-react-lite';
import CkkLoader from '@/components/loader/ckk-loader';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useStore } from '@/hooks/useStore';
import { localize } from '@deriv-com/translations';

const BlocklyLoading = observer(() => {
    const { blockly_store, dashboard } = useStore();
    const { is_loading } = blockly_store;
    const { active_tab } = dashboard;

    /**
     * The Blockly workspace boots in the background while any tab can be open,
     * so this overlay is only shown when the user is actually looking at the
     * Bot Builder. It used to be a full-screen tint over the whole app, which
     * dimmed the Dashboard/Deep Trader and stacked on top of the tab loader.
     */
    if (!is_loading || active_tab !== DBOT_TABS.BOT_BUILDER) return null;

    return (
        <div className='bot__loading' data-testid='blockly-loader' role='status' aria-live='polite'>
            <div className='bot__loading-chip'>
                <CkkLoader />
                <span className='bot__loading-msg'>{localize('Loading Blockly...')}</span>
            </div>
        </div>
    );
});

export default BlocklyLoading;
