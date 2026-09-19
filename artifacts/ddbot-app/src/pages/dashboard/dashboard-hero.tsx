/**
 * DashboardHero - presentation-only overview panel for the Dashboard tab.
 *
 * Reads existing state only:
 *   - active Deriv account + balance  (client store / useActiveAccount)
 *   - WebSocket connection status     (useApiBase)
 *   - bot run statistics              (transactions store)
 *
 * It never fabricates balances, prices or trade data: any section without
 * real data renders an explicit empty state instead.
 */
import React from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import Money from '@/components/shared_ui/money';
import { DBOT_TABS } from '@/constants/bot-contents';
import { CONNECTION_STATUS } from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import useActiveAccount from '@/hooks/api/account/useActiveAccount';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { Localize, localize } from '@deriv-com/translations';

type THeroProps = {
    handleTabChange: (tab_index: number) => void;
};

type TModule = {
    tab: number;
    label: string;
    icon: string;
};

/**
 * Platform modules - the tabs that already exist in src/pages/main/main.tsx,
 * addressed by the same index the tab bar uses and opened through the
 * existing handleTabChange() callback. No new routes are introduced.
 * Tabs 6 / 7 / 8 are the AI Bots, D Circles and Deep Trader tabs.
 */
const MODULES: TModule[] = [
    { tab: DBOT_TABS.BOT_BUILDER, label: localize('Bot Builder'), icon: 'BB' },
    { tab: DBOT_TABS.CHART, label: localize('Charts'), icon: 'CH' },
    { tab: DBOT_TABS.FREE_BOTS, label: localize('Free Bots'), icon: 'FB' },
    { tab: DBOT_TABS.ANALYSIS_TOOL, label: localize('Analysis Tool'), icon: 'AT' },
    { tab: 6, label: localize('AI Bots'), icon: 'AI' },
    { tab: 7, label: localize('D Circles'), icon: 'DC' },
    { tab: 8, label: localize('Deep Trader'), icon: 'DT' },
    { tab: DBOT_TABS.TUTORIAL, label: localize('Tutorials'), icon: 'TU' },
];

const DashboardHero = observer(({ handleTabChange }: THeroProps) => {
    const { client, transactions } = useStore();
    const { connectionStatus, isLoggedIn } = useApiBase();
    const { data: activeAccount } = useActiveAccount({ allBalanceData: client?.all_accounts_balance });
    const { total_stake, total_payout, total_profit, number_of_runs } = transactions.display_statistics;
    const currency = client?.currency;
    const is_feed_open = connectionStatus === CONNECTION_STATUS.OPENED;
    const has_account = isLoggedIn && !!activeAccount;

    return (
        <React.Fragment>
            <section className='dash-hero fx-card fx-card--accent'>
                <div className='dash-hero__intro'>
                    <span className='fx-eyebrow'><Localize i18n_default_text='Deriv Bot' /></span>
                    <h1 className='dash-hero__title'><Localize i18n_default_text='Automated trading terminal' /></h1>
                    <p className='dash-hero__text'><Localize i18n_default_text='Build a bot with drag-and-drop blocks, follow the live chart and study digital-options analytics, all on your Deriv account.' /></p>
                    <div className='dash-hero__actions'>
                        <button type='button' className='fx-btn fx-btn--primary' onClick={() => handleTabChange(DBOT_TABS.BOT_BUILDER)}><Localize i18n_default_text='Build a bot' /></button>
                        <button type='button' className='fx-btn' onClick={() => handleTabChange(DBOT_TABS.FREE_BOTS)}><Localize i18n_default_text='Browse free bots' /></button>
                        <button type='button' className='fx-btn' onClick={() => handleTabChange(DBOT_TABS.CHART)}><Localize i18n_default_text='Open charts' /></button>
                    </div>
                </div>
                <aside className='dash-hero__aside'>
                    <div className='dash-hero__account'>
                        <span className='fx-stat__label'>{has_account ? <Localize i18n_default_text='Account balance' /> : <Localize i18n_default_text='Session' />}</span>
                        {has_account ? (
                            <React.Fragment>
                                <span className='dash-hero__balance'>{activeAccount?.balance} <em>{currency}</em></span>
                                <span className='dash-hero__meta'>
                                    {activeAccount?.loginid}
                                    {activeAccount?.isVirtual && <span className='fx-pill fx-pill--warn'><Localize i18n_default_text='Demo' /></span>}
                                </span>
                            </React.Fragment>
                        ) : (
                            <React.Fragment>
                                <span className='dash-hero__balance dash-hero__balance--sm'><Localize i18n_default_text='Preview mode' /></span>
                                <span className='dash-hero__meta'><Localize i18n_default_text='Log in to load your Deriv account and balance.' /></span>
                            </React.Fragment>
                        )}
                    </div>
                    <div className='dash-hero__pills'>
                        <span className={classNames('fx-pill', is_feed_open ? 'fx-pill--live' : 'fx-pill--off')}>{is_feed_open ? <Localize i18n_default_text='Market feed connected' /> : <Localize i18n_default_text='Connecting' />}</span>
                    </div>
                </aside>
            </section>
            <section className='dash-stats'>
                <h2 className='fx-section-title'><Localize i18n_default_text='Session summary' /></h2>
                {number_of_runs > 0 ? (
                    <div className='dash-stats__grid'>
                        <div className='fx-stat'>
                            <span className='fx-stat__label'><Localize i18n_default_text='Total stake' /></span>
                            <span className='fx-stat__value'><Money amount={total_stake} currency={currency} show_currency /></span>
                        </div>
                        <div className='fx-stat'>
                            <span className='fx-stat__label'><Localize i18n_default_text='Total payout' /></span>
                            <span className='fx-stat__value'><Money amount={total_payout} currency={currency} show_currency /></span>
                        </div>
                        <div className='fx-stat'>
                            <span className='fx-stat__label'><Localize i18n_default_text='Total profit' /></span>
                            <span className={classNames('fx-stat__value', { 'fx-stat__value--up': total_profit > 0, 'fx-stat__value--down': total_profit < 0 })}><Money amount={total_profit} currency={currency} show_currency has_sign /></span>
                        </div>
                        <div className='fx-stat'>
                            <span className='fx-stat__label'><Localize i18n_default_text='Runs' /></span>
                            <span className='fx-stat__value'>{number_of_runs}</span>
                        </div>
                    </div>
                ) : (
                    <p className='dash-stats__empty'><Localize i18n_default_text='No bot runs in this session yet. Statistics appear here once your bot places its first trade.' /></p>
                )}
            </section>

            <section className='dash-modules'>
                <h2 className='fx-section-title'><Localize i18n_default_text='Platform modules' /></h2>
                <div className='dash-modules__grid'>
                    {MODULES.map(module => (
                        <button key={module.tab} type='button' className='fx-card dash-module' onClick={() => handleTabChange(module.tab)}>
                            <span className='dash-module__icon' aria-hidden='true'>{module.icon}</span>
                            <span className='dash-module__label'>{module.label}</span>
                            <span className='dash-module__cta'><Localize i18n_default_text='Open' /></span>
                        </button>
                    ))}
                </div>
            </section>
        </React.Fragment>
    );
});

export default DashboardHero;