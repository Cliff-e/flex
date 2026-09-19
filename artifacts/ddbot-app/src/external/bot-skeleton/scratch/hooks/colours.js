const lightMode = () => {
    const workspace = Blockly;
    /* ------------------------------------------------------------------
       Root blocks (the bot's outer structure): "1. Trade parameters",
       "2. Purchase conditions", "3. Sell conditions", "4. Restart trading
       conditions", tick analysis, block holders, etc. Dark green (#1b5e20)
       so the XML skeleton carries the CKK Edge green instead of the old
       dark blue (#064e72). Blockly derives the border/highlight shades from
       this value, so the whole outer frame follows automatically.
       ------------------------------------------------------------------ */
    workspace.Colours.RootBlock = {
        colour: '#1b5e20',
        colourSecondary: '#1b5e20',
        colourTertiary: '#6d7278',
    };

    workspace.Colours.Base = {
        colour: '#e5e5e5',
        colourSecondary: '#ffffff',
        colourTertiary: '#6d7278',
    };

    workspace.Colours.Special1 = {
        colour: '#e5e5e5',
        colourSecondary: '#ffffff',
        colourTertiary: '#6d7278',
    };

    workspace.Colours.Special2 = {
        colour: '#e5e5e5',
        colourSecondary: '#ffffff',
        colourTertiary: '#6d7278',
    };

    workspace.Colours.Special3 = {
        colour: '#e5e5e5',
        colourSecondary: '#ffffff',
        colourTertiary: '#6d7278',
    };

    workspace.Colours.Special4 = {
        colour: '#e5e5e5',
        colourSecondary: '#000000',
        colourTertiary: '#0e0e0e',
    };
};

export const setColors = () => lightMode();
