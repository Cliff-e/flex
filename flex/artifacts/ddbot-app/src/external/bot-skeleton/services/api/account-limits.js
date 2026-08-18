export default class AccountLimits {
    constructor(store) {
        this.ws = store.ws;
    }
    // eslint-disable-next-line default-param-last
    getStakePayoutLimits(currency = 'AUD', landing_company_shortcode = 'svg', selected_market) {
        // `landing_company_details` no longer exists on api.derivws.com — it returns
        // UnrecognisedRequest.  Return an empty limits object so callers degrade
        // gracefully (no stake/payout enforcement) rather than throwing.
        return this.ws
            .send({
                landing_company_details: landing_company_shortcode,
            })
            .then(landing_company => {
                const currency_config = landing_company?.landing_company_details?.currency_config[selected_market];
                return currency_config ? currency_config[currency] : {};
            })
            .catch(err => {
                console.warn('[AccountLimits] landing_company_details not supported (non-critical):', err?.error?.code);
                return {};
            });
    }
}
