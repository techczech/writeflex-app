/** The DOM event main dispatches on the window's top frame to ask widget-frame to take the keyboard back
 *  from a widget the writer has not engaged (src/main/widget-keyboard.ts). A widget's frame, being of
 *  another origin, cannot dispatch it there. */
export const WIDGET_RECLAIM_EVENT = 'writeflex-widget-reclaim-keyboard'
