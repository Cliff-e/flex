import React from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import Text from '@/components/shared_ui/text';
import { useStore } from '@/hooks/useStore';
import { LabelPairedChevronDownMdFillIcon } from '@deriv/quill-icons/LabelPaired';
import { localize } from '@deriv-com/translations';
import SearchBox from './search-box';
import './mobile-toolbox.scss';

/**
 * Blocks menu for phones and tablets.
 *
 * The desktop toolbox cannot be rendered below 1280px (a 236px wide sidebar does
 * not fit next to the workspace), which left mobile users with no way of adding
 * a block. This component re-uses exactly the same store API as the desktop
 * toolbox - the categories come from `toolbox.toolbox_dom`, which is mounted on
 * every device - and hands the selection over to the Flyout, which stays the
 * single place where blocks are rendered and inserted.
 */
const MobileToolbox = observer(() => {
    const { toolbox, flyout } = useStore();
    const {
        hasSubCategory,
        is_search_loading,
        onSearch,
        onSearchBlur,
        onSearchClear,
        onSearchKeyUp,
        onToolboxItemClick,
        onToolboxItemExpand,
        sub_category_index,
        toolbox_dom,
    } = toolbox;
    const { selected_category, setVisibility } = flyout;

    const [is_open, setOpen] = React.useState(false);

    const handleOpen = () => {
        // The sheet takes over from the flyout while it is open.
        setVisibility(false);
        setOpen(true);
    };

    const handleCategoryClick = (category: HTMLElement, index: number) => {
        if (hasSubCategory(category.children)) {
            onToolboxItemExpand(index);
            return;
        }
        setOpen(false);
        onToolboxItemClick(category);
    };

    const handleSubCategoryClick = (sub_category: HTMLElement) => {
        setOpen(false);
        onToolboxItemClick(sub_category);
    };

    /* Search results are rendered by the flyout (setContents makes it visible),
       so the sheet steps aside once a real search term has been submitted. */
    const handleSearch = (values?: { search?: string }) => {
        const search_term = values?.search ?? '';
        onSearch(values ?? {});

        if (search_term.trim().length > 1) {
            setOpen(false);
        }
    };

    return (
        <React.Fragment>
            <button
                type='button'
                className={classNames('mobile-toolbox__trigger', {
                    'mobile-toolbox__trigger--hidden': is_open,
                })}
                data-testid='dt_mobile_toolbox_button'
                aria-haspopup='dialog'
                aria-expanded={is_open}
                aria-label={localize('Blocks menu')}
                onClick={handleOpen}
            >
                <span className='mobile-toolbox__trigger-icon' aria-hidden='true'>
                    {/* grid */}
                    <svg viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                        <rect x='3' y='3' width='7.5' height='7.5' rx='1.5' stroke='currentColor' strokeWidth='1.6' />
                        <rect x='13.5' y='3' width='7.5' height='7.5' rx='1.5' stroke='currentColor' strokeWidth='1.6' />
                        <rect x='3' y='13.5' width='7.5' height='7.5' rx='1.5' stroke='currentColor' strokeWidth='1.6' />
                        <rect
                            x='13.5'
                            y='13.5'
                            width='7.5'
                            height='7.5'
                            rx='1.5'
                            stroke='currentColor'
                            strokeWidth='1.6'
                        />
                    </svg>
                </span>
                <Text size='xs' weight='bold' className='mobile-toolbox__trigger-text'>
                    {localize('Blocks menu')}
                </Text>
            </button>

            {is_open && (
                <div className='mobile-toolbox' data-testid='dt_mobile_toolbox'>
                    <div className='mobile-toolbox__backdrop' onClick={() => setOpen(false)} />
                    <div
                        className='mobile-toolbox__panel'
                        role='dialog'
                        aria-modal='true'
                        aria-label={localize('Blocks menu')}
                    >
                        <div className='mobile-toolbox__header'>
                            <Text size='s' weight='bold'>
                                {localize('Blocks menu')}
                            </Text>
                            <button
                                type='button'
                                className='mobile-toolbox__close'
                                data-testid='dt_mobile_toolbox_close'
                                aria-label={localize('Close')}
                                onClick={() => setOpen(false)}
                            >
                                {/* cross */}
                                <svg viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                                    <path
                                        d='M6 6l12 12M18 6L6 18'
                                        stroke='currentColor'
                                        strokeWidth='1.8'
                                        strokeLinecap='round'
                                    />
                                </svg>
                            </button>
                        </div>

                        <SearchBox
                            is_search_loading={is_search_loading}
                            onSearch={handleSearch}
                            onSearchBlur={onSearchBlur}
                            onSearchClear={onSearchClear}
                            onSearchKeyUp={onSearchKeyUp}
                        />

                        <div className='mobile-toolbox__menu'>
                            {toolbox_dom &&
                                Array.from(toolbox_dom.childNodes as HTMLElement[]).map((category, index) => {
                                    if (category.tagName.toUpperCase() !== 'CATEGORY') {
                                        return null;
                                    }

                                    const has_sub_category = hasSubCategory(category.children);
                                    const is_sub_category_open = sub_category_index.includes(index);

                                    return (
                                        <div
                                            key={`mobile-toolbox__row--${category.getAttribute('id')}`}
                                            className='mobile-toolbox__row'
                                        >
                                            <div
                                                className={classNames('mobile-toolbox__item', {
                                                    'mobile-toolbox__item--active':
                                                        selected_category?.getAttribute('id') ===
                                                        category.getAttribute('id'),
                                                })}
                                                data-testid={`dt_mobile_toolbox_category_${category.getAttribute('id')}`}
                                                onClick={() => handleCategoryClick(category, index)}
                                            >
                                                <Text size='xs' weight='bold'>
                                                    {localize(category.getAttribute('name') as string)}
                                                </Text>
                                                {has_sub_category && (
                                                    <span
                                                        className={classNames('mobile-toolbox__arrow', {
                                                            'mobile-toolbox__arrow--active': is_sub_category_open,
                                                        })}
                                                    >
                                                        <LabelPairedChevronDownMdFillIcon fill='var(--text-general)' />
                                                    </span>
                                                )}
                                            </div>

                                            {has_sub_category &&
                                                is_sub_category_open &&
                                                (Array.from(category.childNodes) as HTMLElement[]).map(
                                                    sub_category => (
                                                        <div
                                                            key={`mobile-toolbox__sub-row--${sub_category.getAttribute(
                                                                'id'
                                                            )}`}
                                                            className={classNames('mobile-toolbox__sub-row', {
                                                                'mobile-toolbox__sub-row--active':
                                                                    selected_category?.getAttribute('id') ===
                                                                    sub_category.getAttribute('id'),
                                                            })}
                                                            onClick={() => handleSubCategoryClick(sub_category)}
                                                        >
                                                            <Text size='xxs'>
                                                                {sub_category.getAttribute('name') as string}
                                                            </Text>
                                                        </div>
                                                    )
                                                )}
                                        </div>
                                    );
                                })}
                        </div>
                    </div>
                </div>
            )}
        </React.Fragment>
    );
});

export default MobileToolbox;
