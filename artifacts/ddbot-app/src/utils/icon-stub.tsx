import React from 'react';

type TIcon = {
    icon?: string;
    size?: string | number;
    custom_color?: string;
    className?: string;
    style?: React.CSSProperties;
    [key: string]: unknown;
};

/**
 * Stub Icon component.
 *
 * Several components import Icon from this path as a placeholder while the
 * real Deriv icon library is being integrated.  This stub accepts all the
 * same props so the build succeeds without changing any component logic.
 * Replace with the real implementation when ready:
 *   export { Icon } from '@deriv/components'
 */
export const Icon: React.FC<TIcon> = ({ className, style }) => (
    <span className={className} style={style} aria-hidden='true' />
);

export default Icon;
