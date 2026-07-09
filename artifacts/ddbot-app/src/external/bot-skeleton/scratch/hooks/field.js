import { runInvisibleEvents } from '../utils';

// Save the raw value from XML before Blockly's validation can reject it (validation
// fails when the field's options are still the init-time placeholder [['', '']] and
// the XML-stored value like '1HZ30V' isn't in that list). We read _intended_value
// later in the deferred symbol-load handler to restore the correct symbol selection.
//
// IMPORTANT: FieldDropdown does NOT define its own fromXml — it inherits from Field.
// So window.Blockly.FieldDropdown.prototype.fromXml is undefined (own-property check).
// We must NOT call _origFromXml.call() if it's undefined; instead fall back to
// the same behaviour Field.prototype.fromXml provides: setValue(textContent).
const _origFromXml = window.Blockly.FieldDropdown.prototype.fromXml;
window.Blockly.FieldDropdown.prototype.fromXml = function (fieldElement) {
    this._intended_value = fieldElement?.textContent?.trim() ?? null;
    if (_origFromXml) {
        _origFromXml.call(this, fieldElement);
    } else {
        // Replicate Field.prototype.fromXml: read the text and call setValue.
        // Validation may reject the value if options haven't been set yet —
        // that's expected; _intended_value preserves the original for later use.
        this.setValue(fieldElement?.textContent ?? '');
    }
};

window.Blockly.FieldDropdown.prototype.updateOptions = function (dropdown_options, options = {}) {
    if (window.Blockly.DropDownDiv.isVisible()) {
        window.Blockly.DropDownDiv.hideWithoutAnimation();
    }

    this.menuGenerator_ = dropdown_options;

    // Blockly won't actually fire an event if the oldValue and newValue are the same. This prop
    // sets the event's oldValue to an empty string so it's always executed.
    let previous_value = this.getValue();

    if (options.should_pretend_empty) {
        previous_value = '';
    }

    // Set a flag indicating whether the default value passed to this function is available in the newly
    // set dropdown options, if false the default option will be the first available one.
    const has_default_value = dropdown_options.findIndex(item => item[1] === options.default_value) !== -1;

    runInvisibleEvents(() => {
        //kept this commented to remove console errors
        //this.setValue('');

        if (has_default_value) {
            this.setValue(options.default_value);
        } else if (dropdown_options.length > 0) {
            // Default to first if option isn't available.
            this.setValue(this.menuGenerator_[0][1]);
        } else {
            this.setValue(previous_value);
        }
    });

    // If "should_trigger_event" prop is omitted or set to true, fire an event.
    if (!options.should_trigger_event || options.should_trigger_event === true) {
        const event = new window.Blockly.Events.BlockChange(
            this.sourceBlock_,
            'field',
            this.name,
            previous_value,
            this.getValue()
        );
        event.recordUndo = false;
        event.group = options.event_group;
        window.Blockly.Events.fire(event);
    }
};
