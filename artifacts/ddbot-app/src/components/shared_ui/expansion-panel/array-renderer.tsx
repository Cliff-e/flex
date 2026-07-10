import React from 'react';
import classNames from 'classnames';
import { TItem } from '../types/common.types';

type TArrayRenderer = {
    array: Array<TItem>;
    open_ids: Array<string>;
    setOpenIds: (props: Array<string>) => void;
};

const ArrayRenderer = ({ array, open_ids, setOpenIds }: TArrayRenderer) => {
    const onArrayItemClick = (id: string) => {
        if (open_ids.includes(id)) {
            setOpenIds(open_ids.filter(open_id => open_id !== id));
        } else {
            setOpenIds([...open_ids, id]);
        }
    };

    return (
        <>
            {array.map((item, index) => {
                const isArray = Array.isArray(item?.value);

                if (isArray) {
                    return (
                        <div key={item.id || index} className="dc-expansion-panel__content-array">
                            <div
                                className={classNames('dc-expansion-panel__content-array', {
                                    'dc-expansion-panel__content-active': open_ids.includes(item.id),
                                })}
                            >
                                <span className="dc-expansion-panel__content-array-item-index">
                                    {`${index + 1}: `}
                                </span>

                                {`(${item.value.length})`}

                                <span
                                    className="dc-expansion-panel__content-chevron-icon"
                                    onClick={() => onArrayItemClick(item.id)}
                                    style={{ cursor: 'pointer', marginLeft: 8 }}
                                >
                                    ▶
                                </span>
                            </div>

                            {open_ids.includes(item.id) && (
                                <ArrayRenderer
                                    array={item.value as Array<TItem>}
                                    open_ids={open_ids}
                                    setOpenIds={setOpenIds}
                                />
                            )}
                        </div>
                    );
                }

                return (
                    <div key={item.id || index} className="dc-expansion-panel__content-array">
                        <span className="dc-expansion-panel__content-array-item-index">
                            {`${index + 1}: `}
                        </span>
                        {item?.value?.toString()}
                    </div>
                );
            })}
        </>
    );
};

export default ArrayRenderer;