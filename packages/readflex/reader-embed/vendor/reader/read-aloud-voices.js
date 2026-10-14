(function webpackUniversalModuleDefinition(root, factory) {
	if(typeof exports === 'object' && typeof module === 'object')
		module.exports = factory(require("React"), require("ReactDOM"));
	else if(typeof define === 'function' && define.amd)
		define("read-aloud-voices", ["React", "ReactDOM"], factory);
	else if(typeof exports === 'object')
		exports["read-aloud-voices"] = factory(require("React"), require("ReactDOM"));
	else
		root["read-aloud-voices"] = factory(root["React"], root["ReactDOM"]);
})(self, (__WEBPACK_EXTERNAL_MODULE__4883__, __WEBPACK_EXTERNAL_MODULE__1845__) => {
return /******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 1845:
/***/ ((module) => {

"use strict";
module.exports = __WEBPACK_EXTERNAL_MODULE__1845__;

/***/ }),

/***/ 2485:
/***/ ((module, exports) => {

var __WEBPACK_AMD_DEFINE_ARRAY__, __WEBPACK_AMD_DEFINE_RESULT__;/*!
	Copyright (c) 2018 Jed Watson.
	Licensed under the MIT License (MIT), see
	http://jedwatson.github.io/classnames
*/
/* global define */

(function () {
	'use strict';

	var hasOwn = {}.hasOwnProperty;
	var nativeCodeString = '[native code]';

	function classNames() {
		var classes = [];

		for (var i = 0; i < arguments.length; i++) {
			var arg = arguments[i];
			if (!arg) continue;

			var argType = typeof arg;

			if (argType === 'string' || argType === 'number') {
				classes.push(arg);
			} else if (Array.isArray(arg)) {
				if (arg.length) {
					var inner = classNames.apply(null, arg);
					if (inner) {
						classes.push(inner);
					}
				}
			} else if (argType === 'object') {
				if (arg.toString !== Object.prototype.toString && !arg.toString.toString().includes('[native code]')) {
					classes.push(arg.toString());
					continue;
				}

				for (var key in arg) {
					if (hasOwn.call(arg, key) && arg[key]) {
						classes.push(key);
					}
				}
			}
		}

		return classes.join(' ');
	}

	if ( true && module.exports) {
		classNames.default = classNames;
		module.exports = classNames;
	} else if (true) {
		// register as 'classnames', consistent with npm package name
		!(__WEBPACK_AMD_DEFINE_ARRAY__ = [], __WEBPACK_AMD_DEFINE_RESULT__ = (function () {
			return classNames;
		}).apply(exports, __WEBPACK_AMD_DEFINE_ARRAY__),
		__WEBPACK_AMD_DEFINE_RESULT__ !== undefined && (module.exports = __WEBPACK_AMD_DEFINE_RESULT__));
	} else // removed by dead control flow
{}
}());


/***/ }),

/***/ 4883:
/***/ ((module) => {

"use strict";
module.exports = __WEBPACK_EXTERNAL_MODULE__4883__;

/***/ }),

/***/ 5338:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {

"use strict";
var __webpack_unused_export__;


var m = __webpack_require__(1845);
if (true) {
  exports.H = m.createRoot;
  __webpack_unused_export__ = m.hydrateRoot;
} else // removed by dead control flow
{ var i; }


/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat get default export */
/******/ 	(() => {
/******/ 		// getDefaultExport function for compatibility with non-harmony modules
/******/ 		__webpack_require__.n = (module) => {
/******/ 			var getter = module && module.__esModule ?
/******/ 				() => (module['default']) :
/******/ 				() => (module);
/******/ 			__webpack_require__.d(getter, { a: getter });
/******/ 			return getter;
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be in strict mode.
(() => {
"use strict";

// EXTERNAL MODULE: external "React"
var external_React_ = __webpack_require__(4883);
var external_React_default = /*#__PURE__*/__webpack_require__.n(external_React_);
// EXTERNAL MODULE: ./node_modules/react-dom/client.js
var client = __webpack_require__(5338);
// EXTERNAL MODULE: external "ReactDOM"
var external_ReactDOM_ = __webpack_require__(1845);
;// ./node_modules/@fluent/sequence/esm/map_sync.js
/**
 * Synchronously map an identifier or an array of identifiers to the best
 * `FluentBundle` instance(s).
 *
 * @param bundles - An iterable of bundles to sift through.
 * @param ids - An id or ids to map.
 */
function mapBundleSync(bundles, ids) {
    if (!Array.isArray(ids)) {
        return getBundleForId(bundles, ids);
    }
    return ids.map(id => getBundleForId(bundles, id));
}
/*
 * Find the best `FluentBundle` with the translation for `id`.
 */
function getBundleForId(bundles, id) {
    for (const bundle of bundles) {
        if (bundle.hasMessage(id)) {
            return bundle;
        }
    }
    return null;
}

;// ./node_modules/cached-iterable/src/cached_iterable.mjs
/*
 * Base CachedIterable class.
 */
class CachedIterable extends Array {
    /**
     * Create a `CachedIterable` instance from an iterable or, if another
     * instance of `CachedIterable` is passed, return it without any
     * modifications.
     *
     * @param {Iterable} iterable
     * @returns {CachedIterable}
     */
    static from(iterable) {
        if (iterable instanceof this) {
            return iterable;
        }

        return new this(iterable);
    }
}

;// ./node_modules/cached-iterable/src/cached_sync_iterable.mjs


/*
 * CachedSyncIterable caches the elements yielded by an iterable.
 *
 * It can be used to iterate over an iterable many times without depleting the
 * iterable.
 */
class CachedSyncIterable extends CachedIterable {
    /**
     * Create an `CachedSyncIterable` instance.
     *
     * @param {Iterable} iterable
     * @returns {CachedSyncIterable}
     */
    constructor(iterable) {
        super();

        if (Symbol.iterator in Object(iterable)) {
            this.iterator = iterable[Symbol.iterator]();
        } else {
            throw new TypeError("Argument must implement the iteration protocol.");
        }
    }

    [Symbol.iterator]() {
        const cached = this;
        let cur = 0;

        return {
            next() {
                if (cached.length <= cur) {
                    cached.push(cached.iterator.next());
                }
                return cached[cur++];
            }
        };
    }

    /**
     * This method allows user to consume the next element from the iterator
     * into the cache.
     *
     * @param {number} count - number of elements to consume
     */
    touchNext(count = 1) {
        let idx = 0;
        while (idx++ < count) {
            const last = this[this.length - 1];
            if (last && last.done) {
                break;
            }
            this.push(this.iterator.next());
        }
        // Return the last cached {value, done} object to allow the calling
        // code to decide if it needs to call touchNext again.
        return this[this.length - 1];
    }
}

;// ./node_modules/cached-iterable/src/cached_async_iterable.mjs


/*
 * CachedAsyncIterable caches the elements yielded by an async iterable.
 *
 * It can be used to iterate over an iterable many times without depleting the
 * iterable.
 */
class CachedAsyncIterable extends CachedIterable {
    /**
     * Create an `CachedAsyncIterable` instance.
     *
     * @param {Iterable} iterable
     * @returns {CachedAsyncIterable}
     */
    constructor(iterable) {
        super();

        if (Symbol.asyncIterator in Object(iterable)) {
            this.iterator = iterable[Symbol.asyncIterator]();
        } else if (Symbol.iterator in Object(iterable)) {
            this.iterator = iterable[Symbol.iterator]();
        } else {
            throw new TypeError("Argument must implement the iteration protocol.");
        }
    }

    /**
     * Asynchronous iterator caching the yielded elements.
     *
     * Elements yielded by the original iterable will be cached and available
     * synchronously. Returns an async generator object implementing the
     * iterator protocol over the elements of the original (async or sync)
     * iterable.
     */
    [Symbol.asyncIterator]() {
        const cached = this;
        let cur = 0;

        return {
            async next() {
                if (cached.length <= cur) {
                    cached.push(cached.iterator.next());
                }
                return cached[cur++];
            }
        };
    }

    /**
     * This method allows user to consume the next element from the iterator
     * into the cache.
     *
     * @param {number} count - number of elements to consume
     */
    async touchNext(count = 1) {
        let idx = 0;
        while (idx++ < count) {
            const last = this[this.length - 1];
            if (last && (await last).done) {
                break;
            }
            this.push(this.iterator.next());
        }
        // Return the last cached {value, done} object to allow the calling
        // code to decide if it needs to call touchNext again.
        return this[this.length - 1];
    }
}

;// ./node_modules/cached-iterable/src/index.mjs



;// ./node_modules/@fluent/react/esm/markup.js
let cachedParseMarkup;
/**
 * We use a function creator to make the reference to `document` lazy. At the
 * same time, it's eager enough to throw in `<LocalizationProvider>` as soon as
 * it's first mounted which reduces the risk of this error making it to the
 * runtime without developers noticing it in development.
 */
function createParseMarkup() {
    if (typeof document === "undefined") {
        // We can't use <template> to sanitize translations.
        throw new Error("`document` is undefined. Without it, translations cannot " +
            "be safely sanitized. Consult the documentation at " +
            "https://github.com/projectfluent/fluent.js/wiki/React-Overlays.");
    }
    if (!cachedParseMarkup) {
        const template = document.createElement("template");
        cachedParseMarkup = function parseMarkup(str) {
            template.innerHTML = str;
            return Array.from(template.content.childNodes);
        };
    }
    return cachedParseMarkup;
}

;// ./node_modules/@fluent/react/vendor/omittedCloseTags.js
/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in this directory.
 */

// For HTML, certain tags should omit their close tag. We keep a whitelist for
// those special-case tags.

var omittedCloseTags = {
  area: true,
  base: true,
  br: true,
  col: true,
  embed: true,
  hr: true,
  img: true,
  input: true,
  keygen: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true,
  // NOTE: menuitem's close tag should be omitted, but that causes problems.
};

/* harmony default export */ const vendor_omittedCloseTags = (omittedCloseTags);

;// ./node_modules/@fluent/react/vendor/voidElementTags.js
/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in this directory.
 */



// For HTML, certain tags cannot have children. This has the same purpose as
// `omittedCloseTags` except that `menuitem` should still have its closing tag.

var voidElementTags = {
  menuitem: true,
  ...vendor_omittedCloseTags,
};

/* harmony default export */ const vendor_voidElementTags = (voidElementTags);

;// ./node_modules/@fluent/react/esm/localization.js





// Match the opening angle bracket (<) in HTML tags, and HTML entities like
// &amp;, &#0038;, &#x0026;.
const reMarkup = /<|&#?\w+;/;
const defaultReportError = (error) => {
    /* global console */
    // eslint-disable-next-line no-console
    console.warn(`[@fluent/react] ${error.name}: ${error.message}`);
};
/**
 * `ReactLocalization` handles translation formatting and fallback.
 *
 * The current negotiated fallback chain of languages is stored in the
 * `ReactLocalization` instance in form of an iterable of `FluentBundle`
 * instances. This iterable is used to find the best existing translation for
 * a given identifier.
 *
 * The `ReactLocalization` class instances are exposed to `Localized` elements
 * via the `LocalizationProvider` component.
 */
class ReactLocalization {
    constructor(bundles, parseMarkup = createParseMarkup(), reportError) {
        this.bundles = CachedSyncIterable.from(bundles);
        this.parseMarkup = parseMarkup;
        this.reportError = reportError || defaultReportError;
    }
    getBundle(id) {
        return mapBundleSync(this.bundles, id);
    }
    areBundlesEmpty() {
        // Create an iterator and only peek at the first value to see if it contains
        // anything.
        return Boolean(this.bundles[Symbol.iterator]().next().done);
    }
    getString(id, vars, fallback) {
        const bundle = this.getBundle(id);
        if (bundle) {
            const msg = bundle.getMessage(id);
            if (msg && msg.value) {
                let errors = [];
                let value = bundle.formatPattern(msg.value, vars, errors);
                for (let error of errors) {
                    this.reportError(error);
                }
                return value;
            }
        }
        else {
            if (this.areBundlesEmpty()) {
                this.reportError(new Error("Attempting to get a string when no localization bundles are " +
                    "present."));
            }
            else {
                this.reportError(new Error(`The id "${id}" did not match any messages in the localization ` +
                    "bundles."));
            }
        }
        return fallback || id;
    }
    getElement(sourceElement, id, args = {}) {
        const bundle = this.getBundle(id);
        if (bundle === null) {
            if (!id) {
                this.reportError(new Error("No string id was provided when localizing a component."));
            }
            else if (this.areBundlesEmpty()) {
                this.reportError(new Error("Attempting to get a localized element when no localization bundles are " +
                    "present."));
            }
            else {
                this.reportError(new Error(`The id "${id}" did not match any messages in the localization ` +
                    "bundles."));
            }
            return (0,external_React_.createElement)(external_React_.Fragment, null, sourceElement);
        }
        // this.getBundle makes the bundle.hasMessage check which ensures that
        // bundle.getMessage returns an existing message.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const msg = bundle.getMessage(id);
        let errors = [];
        let localizedProps;
        // The default is to forbid all message attributes. If the attrs prop exists
        // on the Localized instance, only set message attributes which have been
        // explicitly allowed by the developer.
        if (args.attrs && msg.attributes) {
            localizedProps = {};
            errors = [];
            for (const [name, allowed] of Object.entries(args.attrs)) {
                if (allowed && name in msg.attributes) {
                    localizedProps[name] = bundle.formatPattern(msg.attributes[name], args.vars, errors);
                }
            }
            for (let error of errors) {
                this.reportError(error);
            }
        }
        // If the component to render is a known void element, explicitly dismiss the
        // message value and do not pass it to cloneElement in order to avoid the
        // "void element tags must neither have `children` nor use
        // `dangerouslySetInnerHTML`" error.
        if (typeof sourceElement.type === "string" &&
            sourceElement.type in vendor_voidElementTags) {
            return (0,external_React_.cloneElement)(sourceElement, localizedProps);
        }
        // If the message has a null value, we're only interested in its attributes.
        // Do not pass the null value to cloneElement as it would nuke all children
        // of the wrapped component.
        if (msg.value === null) {
            return (0,external_React_.cloneElement)(sourceElement, localizedProps);
        }
        errors = [];
        const messageValue = bundle.formatPattern(msg.value, args.vars, errors);
        for (let error of errors) {
            this.reportError(error);
        }
        // If the message value doesn't contain any markup nor any HTML entities,
        // insert it as the only child of the component to render.
        if (!reMarkup.test(messageValue) || this.parseMarkup === null) {
            return (0,external_React_.cloneElement)(sourceElement, localizedProps, messageValue);
        }
        let elemsLower;
        if (args.elems) {
            elemsLower = new Map();
            for (let [name, elem] of Object.entries(args.elems)) {
                // Ignore elems which are not valid React elements.
                if (!(0,external_React_.isValidElement)(elem)) {
                    continue;
                }
                elemsLower.set(name.toLowerCase(), elem);
            }
        }
        // If the message contains markup, parse it and try to match the children
        // found in the translation with the args passed to this function.
        const translationNodes = this.parseMarkup(messageValue);
        const translatedChildren = translationNodes.map(({ nodeName, textContent }) => {
            if (nodeName === "#text") {
                return textContent;
            }
            const childName = nodeName.toLowerCase();
            const sourceChild = elemsLower === null || elemsLower === void 0 ? void 0 : elemsLower.get(childName);
            // If the child is not expected just take its textContent.
            if (!sourceChild) {
                return textContent;
            }
            // If the element passed in the elems prop is a known void element,
            // explicitly dismiss any textContent which might have accidentally been
            // defined in the translation to prevent the "void element tags must not
            // have children" error.
            if (typeof sourceChild.type === "string" &&
                sourceChild.type in vendor_voidElementTags) {
                return sourceChild;
            }
            // TODO Protect contents of elements wrapped in <Localized>
            // https://github.com/projectfluent/fluent.js/issues/184
            // TODO  Control localizable attributes on elements passed as props
            // https://github.com/projectfluent/fluent.js/issues/185
            return (0,external_React_.cloneElement)(sourceChild, undefined, textContent);
        });
        return (0,external_React_.cloneElement)(sourceElement, localizedProps, ...translatedChildren);
    }
}

;// ./node_modules/@fluent/react/esm/context.js

let context_FluentContext = (0,external_React_.createContext)(null);

;// ./node_modules/@fluent/react/esm/provider.js


/**
 * The Provider component for the `ReactLocalization` class.
 *
 * Exposes a `ReactLocalization` instance to all descendants via React's
 * context feature.  It makes translations available to all localizable
 * elements in the descendant's render tree without the need to pass them
 * explicitly.
 *
 * `LocalizationProvider` takes an instance of `ReactLocalization` in the
 * `l10n` prop. This instance will be made available to `Localized` components
 * under the provider.
 *
 * @example
 * ```jsx
 * <LocalizationProvider l10n={…}>
 *     …
 * </LocalizationProvider>
 * ```
 */
function LocalizationProvider(props) {
    return (0,external_React_.createElement)(context_FluentContext.Provider, { value: props.l10n }, props.children);
}

;// ./node_modules/@fluent/react/esm/with_localization.js


function withLocalization(Inner) {
    function WithLocalization(props) {
        const l10n = useContext(FluentContext);
        if (!l10n) {
            throw new Error("withLocalization was used without wrapping it in a " +
                "<LocalizationProvider />.");
        }
        // Re-bind getString to trigger a re-render of Inner.
        const getString = l10n.getString.bind(l10n);
        return createElement(Inner, { getString, ...props });
    }
    WithLocalization.displayName = `WithLocalization(${displayName(Inner)})`;
    return WithLocalization;
}
function displayName(component) {
    return component.displayName || component.name || "Component";
}

;// ./node_modules/@fluent/react/esm/localized.js


/**
 * The `Localized` class renders its child with translated props and children.
 *
 * The `id` prop should be the unique identifier of the translation.  Any
 * attributes found in the translation will be applied to the wrapped element.
 *
 * Arguments to the translation can be passed as `$`-prefixed props on
 * `Localized`.
 *
 * It's recommended that the contents of the wrapped component be a string
 * expression.  The string will be used as the ultimate fallback if no
 * translation is available.  It also makes it easy to grep for strings in the
 * source code.
 *
 * @example
 * ```jsx
 * <Localized id="hello-world">
 *     <p>{'Hello, world!'}</p>
 * </Localized>
 *
 * <Localized id="hello-world" $username={name}>
 *     <p>{'Hello, { $username }!'}</p>
 * </Localized>
 * ```
 */
function Localized(props) {
    const { id, attrs, vars, elems, children } = props;
    const l10n = useContext(FluentContext);
    if (!l10n) {
        throw new Error("The <Localized /> component was not properly wrapped in a <LocalizationProvider />.");
    }
    let source;
    if (Array.isArray(children)) {
        if (children.length > 1) {
            throw new Error("Expected to receive a single React element to localize.");
        }
        // If it's an array with zero or one element, we can directly get the first one.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        source = children[0];
    }
    else {
        source = children !== null && children !== void 0 ? children : null;
    }
    // Check if the component to render is a valid element -- if not, then
    // it's either null or a simple fallback string. No need to localize the
    // attributes or replace.
    if (!isValidElement(source)) {
        const fallback = typeof source === "string" ? source : undefined;
        const string = l10n.getString(id, vars, fallback);
        return React.createElement(React.Fragment, null, string);
    }
    return l10n.getElement(source, id, { attrs, vars, elems });
}
/* harmony default export */ const localized = ((/* unused pure expression or super */ null && (Localized)));

;// ./node_modules/@fluent/react/esm/use_localization.js


const useLocalization = () => {
    const l10n = (0,external_React_.useContext)(context_FluentContext);
    if (!l10n) {
        throw new Error("useLocalization was used without wrapping it in a " +
            "<LocalizationProvider />.");
    }
    return { l10n };
};

;// ./node_modules/@fluent/react/esm/index.js
/**
 * @module fluent-react
 * @overview
 *

 * `fluent-react` provides React bindings for Fluent.  It takes advantage of
 * React's Components system and the virtual DOM.  Translations are exposed to
 * components via the provider pattern.
 *
 * Consult the documentation of the `LocalizationProvider` and the `Localized`
 * components for more information.
 *
 * @example
 * ```jsx
 * <LocalizationProvider l10n={…}>
 *     <Localized id="hello-world">
 *         <p>{'Hello, world!'}</p>
 *     </Localized>
 * </LocalizationProvider>
 * ```
 */






// EXTERNAL MODULE: ./node_modules/classnames/index.js
var classnames = __webpack_require__(2485);
var classnames_default = /*#__PURE__*/__webpack_require__.n(classnames);
;// ./src/common/components/modal-popup/common/dialog-popup.js


function DialogPopup({
  className,
  children,
  onClose,
  onSubmit
}) {
  let overlayRef = (0,external_React_.useRef)();
  (0,external_React_.useLayoutEffect)(() => {
    let node = overlayRef.current.querySelector('[data-default-focus]');
    if (node) {
      node.focus();
    } else {
      overlayRef.current.focus();
    }
  }, []);
  function handlePointerDown(event) {
    if (event.target === overlayRef.current) {
      onClose?.();
    }
  }
  function handleKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (onSubmit) {
        onSubmit(event);
        return;
      }
      onClose?.();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
    }
  }
  return /*#__PURE__*/external_React_default().createElement("div", {
    ref: overlayRef,
    className: "overlay dialog-popup-overlay",
    onPointerDown: handlePointerDown,
    onKeyDown: handleKeyDown,
    tabIndex: -1
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: classnames_default()('modal-popup', className)
  }, children));
}
/* harmony default export */ const dialog_popup = (DialogPopup);
;// ./src/common/read-aloud/components/bullet-list.js


const TIER_BULLETS = {
  local: ['os-provided', 'offline', 'no-account', 'free'],
  standard: ['natural-sounding', 'online-only', 'account-required', 'limited-languages', 'no-multilingual', 'internal-processing', 'unlimited-with-subscription'],
  premium: ['highest-quality', 'online-only', 'account-required', 'broad-languages', 'multilingual', 'external-processing', 'subscription-minutes', 'beta-credits']
};
function BulletList({
  tier,
  onPurchaseCredits
}) {
  const {
    l10n
  } = useLocalization();
  let prefix = `reader-read-aloud-first-run-voice-tier-${tier}-bullet`;
  let bullets = TIER_BULLETS[tier];
  let lines = bullets.map(name => l10n.getString(`${prefix}-${name}`));
  function renderLine(line) {
    let parts = [];
    let match = line.match(/^(.*?)<purchase-credits>(.+)<\/purchase-credits>(.*)$/);
    if (match && onPurchaseCredits) {
      let [, before, button, after] = match;
      if (before) {
        parts.push( /*#__PURE__*/external_React_default().createElement("span", {
          key: "before"
        }, before));
      }
      parts.push( /*#__PURE__*/external_React_default().createElement("button", {
        key: "button",
        className: "purchase-credits",
        type: "button",
        onClick: onPurchaseCredits
      }, button));
      if (after) {
        parts.push( /*#__PURE__*/external_React_default().createElement("span", {
          key: "after"
        }, after));
      }
    } else {
      parts.push( /*#__PURE__*/external_React_default().createElement("span", {
        key: "line"
      }, line));
    }
    return parts;
  }
  return /*#__PURE__*/external_React_default().createElement("ul", null, lines.map((line, i) => /*#__PURE__*/external_React_default().createElement("li", {
    key: i
  }, renderLine(line))));
}
;// ./res/icons/8/chevron-8.svg
var _path;
function _extends() { _extends = Object.assign ? Object.assign.bind() : function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return _extends.apply(this, arguments); }

const SvgChevron8 = props => /*#__PURE__*/external_React_.createElement("svg", _extends({
  xmlns: "http://www.w3.org/2000/svg",
  width: 8,
  height: 8,
  fill: "none"
}, props), _path || (_path = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  d: "m0 2.707 4 4 4-4L7.293 2 4 5.293.707 2z"
})));
/* harmony default export */ const chevron_8 = (SvgChevron8);
;// ./src/common/components/common/custom-select.js



const ROW_HEIGHT = 24;
const SCROLL_PADDING = 10; // 5px on each vertical edge of .scroll-container

function snapMaxHeight(maxH, overhead, scrollContainer) {
  if (!scrollContainer) {
    let available = maxH - overhead - SCROLL_PADDING;
    let rows = Math.floor(available / ROW_HEIGHT);
    if (rows < 1) rows = 1;
    return rows * ROW_HEIGHT + SCROLL_PADDING + overhead;
  }
  // Snap to actual item boundaries to avoid cutting items in half,
  // even when non-uniform-height elements like dividers are present
  let availableHeight = maxH - overhead - SCROLL_PADDING;
  let totalHeight = 0;
  for (let child of scrollContainer.children) {
    let childHeight = child.offsetHeight;
    let style = getComputedStyle(child);
    childHeight += parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    if (totalHeight + childHeight > availableHeight) break;
    totalHeight += childHeight;
  }
  if (totalHeight === 0) totalHeight = ROW_HEIGHT;
  return totalHeight + SCROLL_PADDING + overhead;
}
function findSelectedOption(options, value) {
  return options.find(o => o.value === value) ?? null;
}
function CustomSelect({
  value,
  onChange,
  options,
  'aria-label': ariaLabel,
  tabIndex,
  disabled,
  className,
  showSecondaryLabelOnMenu
}) {
  let [open, setOpen] = (0,external_React_.useState)(false);
  let [focusedId, setFocusedId] = (0,external_React_.useState)(null);
  let [canScrollUp, setCanScrollUp] = (0,external_React_.useState)(false);
  let [canScrollDown, setCanScrollDown] = (0,external_React_.useState)(false);
  let triggerRef = (0,external_React_.useRef)();
  let dropdownRef = (0,external_React_.useRef)();
  let overlayRef = (0,external_React_.useRef)();
  let scrollContainerRef = (0,external_React_.useRef)();
  let scrollAnimRef = (0,external_React_.useRef)(null);
  let openedByPointerRef = (0,external_React_.useRef)(false);
  let ignorePointerRef = (0,external_React_.useRef)(false);
  let fullMaxHeightRef = (0,external_React_.useRef)(0);
  let currentMaxHeightRef = (0,external_React_.useRef)(0);
  let dropdownTopRef = (0,external_React_.useRef)(0);
  let measuredOverheadRef = (0,external_React_.useRef)(0);
  let [dropdownPosition, setDropdownPosition] = (0,external_React_.useState)(null);
  let idPrefix = (0,external_React_.useId)();
  let selectableItems = options.filter(item => !item.divider && !item.disabled && !item.header);

  // Type-ahead search
  let searchStringRef = (0,external_React_.useRef)('');
  let searchTimeoutRef = (0,external_React_.useRef)(null);
  let selectedOption = findSelectedOption(options, value);
  function getOptionId(value) {
    return `${idPrefix}-option-${value}`;
  }
  function findSelectableIndex(id) {
    return selectableItems.findIndex(item => getOptionId(item.value) === id);
  }
  function openDropdown() {
    setDropdownPosition(null);
    setOpen(true);
    let selectedIdx = selectableItems.findIndex(item => item.value === value);
    if (selectedIdx === -1) selectedIdx = 0;
    if (selectableItems[selectedIdx]) {
      setFocusedId(getOptionId(selectableItems[selectedIdx].value));
    }
  }
  function closeDropdown() {
    setOpen(false);
    setFocusedId(null);
    if (openedByPointerRef.current) {
      triggerRef.current?.blur();
    } else {
      triggerRef.current?.focus();
    }
  }
  function selectValue(val) {
    closeDropdown();
    if (val !== value) {
      onChange?.(val);
    }
  }
  function moveFocus(direction) {
    let currentIdx = findSelectableIndex(focusedId);
    let nextIdx = currentIdx + direction;
    if (nextIdx >= 0 && nextIdx < selectableItems.length) {
      setFocusedId(getOptionId(selectableItems[nextIdx].value));
    }
  }
  function handleTriggerKeyDown(event) {
    switch (event.key) {
      case 'Enter':
      case ' ':
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        openedByPointerRef.current = false;
        openDropdown();
        break;
      default:
        break;
    }
  }
  function handleDropdownKeyDown(event) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        ignorePointerRef.current = true;
        moveFocus(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        ignorePointerRef.current = true;
        moveFocus(-1);
        break;
      case 'Home':
        event.preventDefault();
        ignorePointerRef.current = true;
        if (selectableItems.length) {
          setFocusedId(getOptionId(selectableItems[0].value));
        }
        break;
      case 'End':
        event.preventDefault();
        ignorePointerRef.current = true;
        if (selectableItems.length) {
          setFocusedId(getOptionId(selectableItems[selectableItems.length - 1].value));
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        {
          let focused = selectableItems.find(item => getOptionId(item.value) === focusedId);
          if (focused && !focused.disabled) {
            selectValue(focused.value);
          }
        }
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        closeDropdown();
        break;
      case 'Tab':
        event.preventDefault();
        closeDropdown();
        break;
      default:
        if (event.key.length === 1 && event.key.match(/\S/)) {
          handleTypeAhead(event.key);
        }
        break;
    }
  }
  function handleTypeAhead(char) {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    searchTimeoutRef.current = setTimeout(() => {
      searchStringRef.current = '';
    }, 2000);
    searchStringRef.current += char.toLowerCase();
    let candidates = selectableItems.filter(item => item.label.toLowerCase().startsWith(searchStringRef.current));
    if (candidates.length) {
      setFocusedId(getOptionId(candidates[0].value));
    }
  }
  let updateScrollIndicators = (0,external_React_.useCallback)(() => {
    let el = scrollContainerRef.current;
    if (!el) return;
    setCanScrollUp(el.scrollTop > 0);
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);
  let wheelAccumRef = (0,external_React_.useRef)(0);
  let handleWheel = (0,external_React_.useCallback)(event => {
    event.preventDefault();
    let el = scrollContainerRef.current;
    if (!el) return;
    let delta = event.deltaY;
    // Reset accumulator on direction change
    if (wheelAccumRef.current > 0 && delta < 0 || wheelAccumRef.current < 0 && delta > 0) {
      wheelAccumRef.current = 0;
    }
    wheelAccumRef.current += delta;

    // Scroll one row each time the accumulated delta crosses the threshold
    let threshold = ROW_HEIGHT;
    let steps = Math.trunc(wheelAccumRef.current / threshold);
    if (steps !== 0) {
      wheelAccumRef.current -= steps * threshold;
      el.scrollTop += steps * ROW_HEIGHT;
      updateScrollIndicators();
      expandDropdownIfNeeded();
    }
  }, [updateScrollIndicators]);
  function handleOverlayPointerDown(event) {
    event.stopPropagation();
    if (event.target === event.currentTarget) {
      event.preventDefault();
      closeDropdown();
    }
  }
  function startScrolling(direction) {
    if (scrollAnimRef.current) return;
    let scroll = () => {
      let el = scrollContainerRef.current;
      if (el) {
        el.scrollTop += direction * ROW_HEIGHT;
        updateScrollIndicators();
        expandDropdownIfNeeded();
      }
    };
    scroll();
    scrollAnimRef.current = setInterval(scroll, 150);
  }
  function stopScrolling() {
    if (scrollAnimRef.current) {
      clearInterval(scrollAnimRef.current);
      scrollAnimRef.current = null;
    }
  }
  function expandDropdownIfNeeded() {
    let el = scrollContainerRef.current;
    if (!el) return;
    let currentMax = currentMaxHeightRef.current;
    let fullMax = fullMaxHeightRef.current;
    if (!fullMax || currentMax >= fullMax) return;
    let padding = 8;
    let expanded = false;

    // Expand downward if there's hidden content below and room in the viewport
    let hiddenBelow = el.scrollHeight - el.scrollTop - el.clientHeight;
    let spaceBelow = window.innerHeight - padding - (dropdownTopRef.current + currentMax);
    if (hiddenBelow > 0 && spaceBelow > 0) {
      let expandBy = Math.min(spaceBelow, hiddenBelow);
      currentMax = Math.min(currentMax + expandBy, fullMax);
      expanded = true;
    }

    // Snap after downward expansion to establish the stable bottom edge
    let bottomEdge = dropdownTopRef.current + currentMax;
    if (expanded) {
      currentMax = snapMaxHeight(currentMax, measuredOverheadRef.current, el);
      bottomEdge = dropdownTopRef.current + currentMax;
    }

    // Expand upward if there's hidden content above and room in the viewport
    let hiddenAbove = el.scrollTop;
    let spaceAbove = dropdownTopRef.current - padding;
    if (hiddenAbove > 0 && spaceAbove > 0) {
      let expandBy = Math.min(spaceAbove, hiddenAbove);
      let newMax = Math.min(currentMax + expandBy, fullMax);
      let actualExpand = newMax - currentMax;
      if (actualExpand > 0) {
        currentMax = newMax;
        currentMax = snapMaxHeight(currentMax, measuredOverheadRef.current, el);
        // Derive top from the fixed bottom edge so it never drifts
        let topExpand = currentMax - (bottomEdge - dropdownTopRef.current);
        if (topExpand > 0) {
          dropdownTopRef.current -= topExpand;
          el.scrollTop -= topExpand;
        }
        expanded = true;
      }
    }
    if (expanded) {
      currentMaxHeightRef.current = currentMax;
      setDropdownPosition(pos => pos && {
        ...pos,
        top: dropdownTopRef.current,
        maxHeight: currentMax
      });
    }
  }
  (0,external_React_.useEffect)(() => {
    if (open && overlayRef.current) {
      overlayRef.current.focus();
    }
    if (!open) {
      stopScrolling();
    }
  }, [open]);

  // Attach wheel listener as non-passive so we can preventDefault()
  (0,external_React_.useEffect)(() => {
    let el = scrollContainerRef.current;
    if (!open || !el) return undefined;
    el.addEventListener('wheel', handleWheel, {
      passive: false
    });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel, open]);

  // Always scroll focused item into view
  (0,external_React_.useEffect)(() => {
    if (!focusedId || !open) return;
    let el = document.getElementById(focusedId);
    if (el) {
      el.scrollIntoView({
        block: 'nearest'
      });
      updateScrollIndicators();
      expandDropdownIfNeeded();
    }
  }, [focusedId, open, updateScrollIndicators]);

  // Align selected item over trigger
  (0,external_React_.useLayoutEffect)(() => {
    if (!open || !dropdownRef.current || !triggerRef.current || !scrollContainerRef.current) return;
    let triggerRect = triggerRef.current.getBoundingClientRect();
    let dropdown = dropdownRef.current;
    let scroller = scrollContainerRef.current;
    let padding = 8;
    let selectedEl = scroller.querySelector('[aria-selected="true"]');
    scroller.scrollTop = 0;
    let scrollHeight = scroller.scrollHeight;
    let dropdownWidth = Math.max(dropdown.offsetWidth, triggerRect.width);
    let measuredOverhead = dropdown.offsetHeight - scroller.clientHeight;
    measuredOverheadRef.current = measuredOverhead;
    let maxHeight = snapMaxHeight(window.innerHeight - padding * 2, measuredOverhead, scroller);
    let dropdownHeight = Math.min(dropdown.offsetHeight, maxHeight);
    let triggerCenter = triggerRect.top + triggerRect.height / 2;
    let top;
    let scrollTop = 0;
    let initialMaxHeight = maxHeight;
    if (selectedEl) {
      let selectedCenter = selectedEl.offsetTop + selectedEl.offsetHeight / 2;

      // Calculate initial constrained height
      // Show items from top of list through selected + 1 buffer item
      let selectedBottom = selectedEl.offsetTop + selectedEl.offsetHeight;
      let buffer = ROW_HEIGHT;
      let candidate = selectedBottom + buffer + SCROLL_PADDING + measuredOverhead;
      candidate = Math.max(candidate, 80);
      candidate = snapMaxHeight(candidate, measuredOverhead, scroller);
      let useConstrainedHeight = candidate < dropdownHeight;
      let effectiveHeight = useConstrainedHeight ? candidate : dropdownHeight;

      // Ideal: position dropdown so the selected item center aligns with trigger center
      top = triggerCenter - selectedCenter;

      // If the dropdown would extend above the viewport, clamp and scroll
      if (top < padding) {
        scrollTop = padding - top;
        top = padding;
      }

      // Same for below the viewport
      if (top + effectiveHeight > window.innerHeight - padding) {
        top = window.innerHeight - padding - effectiveHeight;
        // Recalculate scroll so selected item aligns with trigger
        scrollTop = selectedCenter - (triggerCenter - top);
      }

      // Clamp scroll
      let expectedClientHeight = effectiveHeight - measuredOverhead;
      scrollTop = Math.max(0, Math.min(scrollTop, scrollHeight - expectedClientHeight));

      // Finalize initial max height with actual scrollTop
      if (useConstrainedHeight) {
        let visibleSelectedBottom = selectedBottom - scrollTop;
        initialMaxHeight = visibleSelectedBottom + buffer + SCROLL_PADDING + measuredOverhead;
        initialMaxHeight = Math.max(initialMaxHeight, 80);
        initialMaxHeight = Math.min(initialMaxHeight, maxHeight);
      }
    } else {
      top = triggerRect.top;
      if (top + dropdownHeight > window.innerHeight - padding) {
        top = window.innerHeight - padding - dropdownHeight;
      }
      if (top < padding) {
        top = padding;
      }
    }
    let left = triggerRect.left;
    if (left + dropdownWidth > window.innerWidth - padding) {
      left = window.innerWidth - padding - dropdownWidth;
    }
    if (left < padding) {
      left = padding;
    }

    // Expand to fill available viewport space
    if (initialMaxHeight < maxHeight) {
      let clientHeight = initialMaxHeight - measuredOverhead;
      let hiddenBelow = scrollHeight - scrollTop - clientHeight;
      let spaceBelow = window.innerHeight - padding - (top + initialMaxHeight);
      if (hiddenBelow > 0 && spaceBelow > 0) {
        let expandBy = Math.min(spaceBelow, hiddenBelow);
        initialMaxHeight = Math.min(initialMaxHeight + expandBy, maxHeight);
      }
      let hiddenAbove = scrollTop;
      let spaceAbove = top - padding;
      if (hiddenAbove > 0 && spaceAbove > 0) {
        let expandBy = Math.min(spaceAbove, hiddenAbove);
        let newMax = Math.min(initialMaxHeight + expandBy, maxHeight);
        let actualExpand = newMax - initialMaxHeight;
        if (actualExpand > 0) {
          initialMaxHeight = newMax;
          top -= actualExpand;
          scrollTop -= actualExpand;
        }
      }
    }

    // If there's still hidden content that couldn't be shown by expanding
    // downward/upward, move the dropdown up to make room
    if (scrollHeight + measuredOverhead > initialMaxHeight) {
      let desiredHeight = Math.min(scrollHeight + measuredOverhead, maxHeight);
      let spaceAbove = top - padding;
      let growBy = Math.min(desiredHeight - initialMaxHeight, spaceAbove);
      if (growBy > 0) {
        initialMaxHeight += growBy;
        top -= growBy;
      }
    }
    initialMaxHeight = snapMaxHeight(initialMaxHeight, measuredOverhead, scroller);

    // Clamp to viewport, accounting for border outside max-height (content-box)
    let borderHeight = dropdown.offsetHeight - dropdown.clientHeight;
    let bottomEdge = top + initialMaxHeight + borderHeight;
    if (bottomEdge > window.innerHeight - padding) {
      top -= bottomEdge - (window.innerHeight - padding);
      if (top < padding) {
        initialMaxHeight -= padding - top;
        top = padding;
      }
    }
    fullMaxHeightRef.current = maxHeight;
    currentMaxHeightRef.current = initialMaxHeight;
    dropdownTopRef.current = top;
    scroller.scrollTop = scrollTop;
    setDropdownPosition({
      top,
      left,
      maxHeight: initialMaxHeight,
      minWidth: triggerRect.width
    });
    setTimeout(() => {
      // Mysteriously, this does not work unless it's in a setTimeout(),
      // even if moved to useEffect
      updateScrollIndicators();
    });
  }, [open, updateScrollIndicators, value]);
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: classnames_default()('custom-select', className)
  }, /*#__PURE__*/external_React_default().createElement("button", {
    type: "button",
    ref: triggerRef,
    role: "combobox",
    "aria-haspopup": "listbox",
    "aria-expanded": open,
    "aria-activedescendant": open ? focusedId : undefined,
    "aria-label": ariaLabel,
    tabIndex: tabIndex,
    disabled: disabled,
    className: "custom-select-trigger",
    onClick: () => {
      if (open) {
        closeDropdown();
      } else {
        openedByPointerRef.current = true;
        openDropdown();
      }
    },
    onKeyDown: !open ? handleTriggerKeyDown : undefined
  }, /*#__PURE__*/external_React_default().createElement("span", {
    className: "label"
  }, selectedOption?.label ?? ''), /*#__PURE__*/external_React_default().createElement(chevron_8, {
    className: "chevron"
  })), open && /*#__PURE__*/external_React_default().createElement("div", {
    ref: overlayRef,
    className: "custom-select-overlay",
    tabIndex: -1,
    onPointerDown: handleOverlayPointerDown,
    onKeyDown: handleDropdownKeyDown
  }, /*#__PURE__*/external_React_default().createElement("div", {
    ref: dropdownRef,
    className: "custom-select-dropdown",
    "aria-label": ariaLabel,
    style: {
      '--row-height': ROW_HEIGHT + 'px',
      ...(dropdownPosition || {
        visibility: 'hidden'
      })
    }
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: classnames_default()('scroll-indicator up', {
      hidden: !canScrollUp
    }),
    onPointerEnter: () => startScrolling(-1),
    onPointerLeave: stopScrolling
  }, /*#__PURE__*/external_React_default().createElement(chevron_8, {
    style: {
      transform: 'rotate(180deg)'
    }
  })), /*#__PURE__*/external_React_default().createElement("div", {
    ref: scrollContainerRef,
    className: classnames_default()('scroll-container', {
      'can-scroll-up': canScrollUp,
      'can-scroll-down': canScrollDown
    }),
    role: "listbox",
    onPointerMove: () => ignorePointerRef.current = false,
    onPointerLeave: () => {
      if (!ignorePointerRef.current) {
        setFocusedId(null);
      }
    },
    onScroll: () => {
      updateScrollIndicators();
      expandDropdownIfNeeded();
    }
  }, options.map((item, index) => {
    if (item.divider) {
      return /*#__PURE__*/external_React_default().createElement("div", {
        key: `d-${index}`,
        className: "divider",
        role: "separator"
      });
    }
    if (item.header) {
      return /*#__PURE__*/external_React_default().createElement("div", {
        key: `h-${index}`,
        className: "header",
        role: "presentation",
        onPointerEnter: () => {
          if (!ignorePointerRef.current) {
            setFocusedId(null);
          }
        }
      }, item.label);
    }
    let isSelected = item.value === value;
    let isFocused = focusedId === getOptionId(item.value);
    return /*#__PURE__*/external_React_default().createElement("div", {
      key: item.value,
      id: getOptionId(item.value),
      className: classnames_default()('option', {
        selected: isSelected,
        focused: isFocused,
        disabled: item.disabled
      }),
      role: "option",
      "aria-selected": isSelected,
      "aria-disabled": item.disabled || undefined,
      dir: "auto",
      onPointerEnter: () => {
        if (!ignorePointerRef.current) {
          setFocusedId(getOptionId(item.value));
        }
      },
      onPointerUp: () => {
        if (!item.disabled) {
          selectValue(item.value);
        }
      }
    }, /*#__PURE__*/external_React_default().createElement("span", {
      className: "label"
    }, item.label), showSecondaryLabelOnMenu && item.secondaryLabel && /*#__PURE__*/external_React_default().createElement("span", {
      className: "secondary-label"
    }, item.secondaryLabel));
  })), /*#__PURE__*/external_React_default().createElement("div", {
    className: classnames_default()('scroll-indicator down', {
      hidden: !canScrollDown
    }),
    onPointerEnter: () => startScrolling(1),
    onPointerLeave: stopScrolling
  }, /*#__PURE__*/external_React_default().createElement(chevron_8, null)))));
}
/* harmony default export */ const custom_select = (CustomSelect);
;// ./src/common/read-aloud/lang.ts
// Equivalents for nonstandard language codes
const LANGUAGE_EQUIVALENTS = {
  cmn: 'zh' // Chinese
};

// And region codes
const REGION_EQUIVALENTS = {
  // Arabic
  XA: '001',
  SA: '001',
  // Chinese (local voices)
  CN: '',
  HK: '',
  TW: ''
};

// Default regions for languages with multiple regional variants,
// used when there's no better match (e.g., based on system locale)
const DEFAULT_REGIONS = {
  zh: 'CN',
  nl: 'NL',
  en: 'US',
  fr: 'FR',
  pt: 'BR',
  es: 'ES'
};
function lang_getBaseLanguage(lang) {
  return lang.replace(/-.+$/g, '');
}
function lang_normalizeLanguage(lang) {
  let base = lang_getBaseLanguage(lang);
  let region = lang.includes('-') ? lang.substring(base.length + 1) : '';
  let normalizedBase = LANGUAGE_EQUIVALENTS[base] ?? base;
  let normalizedRegion = REGION_EQUIVALENTS[region] ?? region;
  return normalizedRegion ? `${normalizedBase}-${normalizedRegion}` : normalizedBase;
}
function isLanguageSupported(voiceLang, lang) {
  // Wildcard for non-Zotero TTS APIs that are language-agnostic,
  // e.g. OpenAI
  if (voiceLang === '*' || lang === '*') {
    return true;
  }
  let normalizedLang = lang_normalizeLanguage(lang);
  let baseLang = lang_getBaseLanguage(normalizedLang);
  let hasRegion = normalizedLang.includes('-');
  let normalizedVoiceLang = lang_normalizeLanguage(voiceLang);
  let voiceBaseLang = lang_getBaseLanguage(normalizedVoiceLang);
  let voiceHasRegion = normalizedVoiceLang.includes('-');

  // Base languages must match
  if (voiceBaseLang !== baseLang) {
    return false;
  }

  // If no region specified, accept any variant
  if (!hasRegion) {
    return true;
  }

  // If region specified, accept voices with matching region or no region
  if (!voiceHasRegion || normalizedVoiceLang === normalizedLang) {
    return true;
  }
  return false;
}
function getPreferredRegion(baseLang) {
  let normalizedBase = LANGUAGE_EQUIVALENTS[baseLang] ?? baseLang;
  for (let userLang of navigator.languages) {
    let normalized = lang_normalizeLanguage(userLang);
    if (normalized.startsWith(normalizedBase + '-')) {
      return normalized.substring(normalizedBase.length + 1);
    }
  }
  return DEFAULT_REGIONS[normalizedBase] ?? null;
}

/**
 * Find the best match for a language code in a list of language codes.
 * Tries exact match, then exact regional match, then preferred region,
 * then falls back to first candidate with the same base language.
 */
function resolveLanguage(lang, langs) {
  if (!langs.length) {
    return null;
  }

  // Already in the list
  if (langs.includes(lang)) {
    return lang;
  }
  let normalizedLang = lang_normalizeLanguage(lang);
  let baseLang = lang_getBaseLanguage(normalizedLang);

  // Find candidates with the same base language
  let candidates = langs.filter(candidate => {
    candidate = lang_normalizeLanguage(candidate);
    let candidateBase = lang_getBaseLanguage(candidate);
    return candidateBase === baseLang;
  });
  if (!candidates.length) {
    return null;
  }

  // If normalizedLang has a region, prefer exact regional match
  if (normalizedLang.includes('-')) {
    let exactMatch = candidates.find(c => lang_normalizeLanguage(c) === normalizedLang);
    if (exactMatch) {
      return exactMatch;
    }
  }

  // Use preferred region to pick the best match
  let preferredRegion = getPreferredRegion(baseLang);
  if (preferredRegion) {
    let regionMatch = candidates.find(c => {
      let normalized = lang_normalizeLanguage(c);
      return normalized === `${baseLang}-${preferredRegion}`;
    });
    if (regionMatch) {
      return regionMatch;
    }
  }
  return candidates[0];
}
;// ./src/common/read-aloud/components/language-region-select.js




function LanguageRegionSelect({
  languages,
  lang,
  onLangChange,
  tabIndex
}) {
  const {
    l10n
  } = useLocalization();
  let displayNames = (0,external_React_.useMemo)(() => new Intl.DisplayNames(undefined, {
    type: 'language',
    languageDisplay: 'standard'
  }), []);
  let baseDisplayNames = (0,external_React_.useMemo)(() => new Intl.DisplayNames(undefined, {
    type: 'language',
    languageDisplay: 'standard'
  }), []);
  let options = (0,external_React_.useMemo)(() => {
    // Count how many entries share each base language
    let baseCounts = new Map();
    for (let language of languages) {
      let base = lang_getBaseLanguage(language);
      baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
    }
    let result = [];
    for (let language of languages) {
      let base = lang_getBaseLanguage(language);
      let hasMultipleRegions = baseCounts.get(base) > 1;

      // Use full label (with region) only when there are multiple
      // regions for the same base language
      let label;
      try {
        label = hasMultipleRegions ? displayNames.of(language) : baseDisplayNames.of(base);
      } catch {
        continue;
      }
      if (!label) continue;
      result.push({
        value: language,
        label
      });
    }
    return result.sort((a, b) => a.label.localeCompare(b.label));
  }, [languages, displayNames, baseDisplayNames]);
  return /*#__PURE__*/external_React_default().createElement(custom_select, {
    "aria-label": l10n.getString('reader-read-aloud-language'),
    value: lang,
    tabIndex: tabIndex,
    onChange: onLangChange,
    options: options
  });
}
/* harmony default export */ const language_region_select = (LanguageRegionSelect);
;// ./src/common/read-aloud/voice.ts

class ReadAloudVoice {
  impl;
  provider;
  constructor(provider, impl) {
    this.provider = provider;
    this.impl = impl;
  }
  get minutesRemaining() {
    let creditsRemaining = this.tier === 'standard' ? this.provider.standardCreditsRemaining : this.tier === 'premium' ? this.provider.premiumCreditsRemaining : null;
    let creditsPerMinute = this.creditsPerMinute;
    if (creditsRemaining === null || !creditsPerMinute) {
      return null;
    }
    return creditsRemaining / creditsPerMinute;
  }
}
const TIERS = ['standard', 'premium', 'local'];
function resolveEnabledVoiceIDs(tierVoices, persistedVoiceIDs) {
  if (Array.isArray(persistedVoiceIDs)) {
    return persistedVoiceIDs;
  }
  return tierVoices.filter(v => v.default).map(v => v.id);
}
function getSupportedLanguages(voices) {
  let langs = new Set();
  for (let voice of voices) {
    // Wildcard voices match any language and shouldn't appear as
    // a selectable language option
    if (voice.language === '*') {
      continue;
    }
    let normalized = lang_normalizeLanguage(voice.language);
    langs.add(normalized);
  }
  return [...langs];
}
function getVoicesForLanguage(voices, lang) {
  return voices.filter(voice => isLanguageSupported(voice.language, lang));
}
function getVoiceRegion(voice) {
  if (voice.language === '*') {
    return null;
  }
  let normalized = normalizeLanguage(voice.language);
  let base = getBaseLanguage(normalized);
  return normalized.includes('-') ? normalized.substring(base.length + 1) : null;
}
;// ./src/common/lib/debounce.js
/**
 * https://github.com/lodash/lodash/blob/master/debounce.js
 * Creates a debounced function that delays invoking `func` until after `wait`
 * milliseconds have elapsed since the last time the debounced function was
 * invoked, or until the next browser frame is drawn. The debounced function
 * comes with a `cancel` method to cancel delayed `func` invocations and a
 * `flush` method to immediately invoke them. Provide `options` to indicate
 * whether `func` should be invoked on the leading and/or trailing edge of the
 * `wait` timeout. The `func` is invoked with the last arguments provided to the
 * debounced function. Subsequent calls to the debounced function return the
 * result of the last `func` invocation.
 *
 * **Note:** If `leading` and `trailing` options are `true`, `func` is
 * invoked on the trailing edge of the timeout only if the debounced function
 * is invoked more than once during the `wait` timeout.
 *
 * If `wait` is `0` and `leading` is `false`, `func` invocation is deferred
 * until the next tick, similar to `setTimeout` with a timeout of `0`.
 *
 * If `wait` is omitted in an environment with `requestAnimationFrame`, `func`
 * invocation will be deferred until the next frame is drawn (typically about
 * 16ms).
 *
 * See [David Corbacho's article](https://css-tricks.com/debouncing-throttling-explained-examples/)
 * for details over the differences between `debounce` and `throttle`.
 *
 * @since 0.1.0
 * @category Function
 * @param {Function} func The function to debounce.
 * @param {number} [wait=0]
 *  The number of milliseconds to delay; if omitted, `requestAnimationFrame` is
 *  used (if available).
 * @param {Object} [options={}] The options object.
 * @param {boolean} [options.leading=false]
 *  Specify invoking on the leading edge of the timeout.
 * @param {number} [options.maxWait]
 *  The maximum time `func` is allowed to be delayed before it's invoked.
 * @param {boolean} [options.trailing=true]
 *  Specify invoking on the trailing edge of the timeout.
 * @returns {Function} Returns the new debounced function.
 * @example
 *
 * // Avoid costly calculations while the window size is in flux.
 * jQuery(window).on('resize', debounce(calculateLayout, 150))
 *
 * // Invoke `sendMail` when clicked, debouncing subsequent calls.
 * jQuery(element).on('click', debounce(sendMail, 300, {
 *   'leading': true,
 *   'trailing': false
 * }))
 *
 * // Ensure `batchLog` is invoked once after 1 second of debounced calls.
 * const debounced = debounce(batchLog, 250, { 'maxWait': 1000 })
 * const source = new EventSource('/stream')
 * jQuery(source).on('message', debounced)
 *
 * // Cancel the trailing debounced invocation.
 * jQuery(window).on('popstate', debounced.cancel)
 *
 * // Check for pending invocations.
 * const status = debounced.pending() ? "Pending..." : "Ready"
 */
function debounce(func, wait, options) {
  let root = window;
  let lastArgs, lastThis, maxWait, result, timerID, lastCallTime;
  let lastInvokeTime = 0;
  let leading = false;
  let maxing = false;
  let trailing = true;

  // Bypass `requestAnimationFrame` by explicitly setting `wait=0`.
  const useRAF = !wait && wait !== 0 && typeof root.requestAnimationFrame === 'function';
  if (typeof func !== 'function') {
    throw new TypeError('Expected a function');
  }
  wait = +wait || 0;
  if (isObject(options)) {
    leading = !!options.leading;
    maxing = 'maxWait' in options;
    maxWait = maxing ? Math.max(+options.maxWait || 0, wait) : maxWait;
    trailing = 'trailing' in options ? !!options.trailing : trailing;
  }
  function isObject(value) {
    const type = typeof value;
    return value != null && (type === 'object' || type === 'function');
  }
  function invokeFunc(time) {
    const args = lastArgs;
    const thisArg = lastThis;
    lastArgs = lastThis = undefined;
    lastInvokeTime = time;
    result = func.apply(thisArg, args);
    return result;
  }
  function startTimer(pendingFunc, wait) {
    if (useRAF) {
      root.cancelAnimationFrame(timerID);
      return root.requestAnimationFrame(pendingFunc);
    }
    return setTimeout(pendingFunc, wait);
  }
  function cancelTimer(id) {
    if (useRAF) {
      return root.cancelAnimationFrame(id);
    }
    clearTimeout(id);
  }
  function leadingEdge(time) {
    // Reset any `maxWait` timer.
    lastInvokeTime = time;
    // Start the timer for the trailing edge.
    timerID = startTimer(timerExpired, wait);
    // Invoke the leading edge.
    return leading ? invokeFunc(time) : result;
  }
  function remainingWait(time) {
    const timeSinceLastCall = time - lastCallTime;
    const timeSinceLastInvoke = time - lastInvokeTime;
    const timeWaiting = wait - timeSinceLastCall;
    return maxing ? Math.min(timeWaiting, maxWait - timeSinceLastInvoke) : timeWaiting;
  }
  function shouldInvoke(time) {
    const timeSinceLastCall = time - lastCallTime;
    const timeSinceLastInvoke = time - lastInvokeTime;

    // Either this is the first call, activity has stopped and we're at the
    // trailing edge, the system time has gone backwards and we're treating
    // it as the trailing edge, or we've hit the `maxWait` limit.
    return lastCallTime === undefined || timeSinceLastCall >= wait || timeSinceLastCall < 0 || maxing && timeSinceLastInvoke >= maxWait;
  }
  function timerExpired() {
    const time = Date.now();
    if (shouldInvoke(time)) {
      return trailingEdge(time);
    }
    // Restart the timer.
    timerID = startTimer(timerExpired, remainingWait(time));
  }
  function trailingEdge(time) {
    timerID = undefined;

    // Only invoke if we have `lastArgs` which means `func` has been
    // debounced at least once.
    if (trailing && lastArgs) {
      return invokeFunc(time);
    }
    lastArgs = lastThis = undefined;
    return result;
  }
  function cancel() {
    if (timerID !== undefined) {
      cancelTimer(timerID);
    }
    lastInvokeTime = 0;
    lastArgs = lastCallTime = lastThis = timerID = undefined;
  }
  function flush() {
    return timerID === undefined ? result : trailingEdge(Date.now());
  }
  function pending() {
    return timerID !== undefined;
  }
  function debounced(...args) {
    const time = Date.now();
    const isInvoking = shouldInvoke(time);
    lastArgs = args;
    lastThis = this;
    lastCallTime = time;
    if (isInvoking) {
      if (timerID === undefined) {
        return leadingEdge(lastCallTime);
      }
      if (maxing) {
        // Handle invocations in a tight loop.
        timerID = startTimer(timerExpired, wait);
        return invokeFunc(lastCallTime);
      }
    }
    if (timerID === undefined) {
      timerID = startTimer(timerExpired, wait);
    }
    return result;
  }
  debounced.cancel = cancel;
  debounced.flush = flush;
  debounced.pending = pending;
  return debounced;
}
;// ./src/common/read-aloud/controller.ts
const DELAY_PARAGRAPH = 200;
class ReadAloudController extends EventTarget {
  voice;
  lang;
  _segments;
  _position;
  _buffering = false;
  _backwardStopIndex;
  _forwardStopIndex;
  _paused = false;
  _pausedAt = null;
  _speed = 1;
  _error = null;
  _destroyed = false;
  _delayTimeout = null;
  lastSkipGranularity = null;
  get paused() {
    return this._paused;
  }
  set paused(paused) {
    if (paused) {
      this._pausedAt = performance.now();
    }
    this._paused = paused;
    this._clearDelayTimeout();
    this._speak();
  }
  get speed() {
    return this._speed;
  }
  set speed(speed) {
    this._speed = speed;
    this._onSpeedChange();
  }
  _onSpeedChange() {
    this._speak();
  }
  get _pauseDurationSeconds() {
    if (this._pausedAt === null) {
      return 0;
    }
    return (performance.now() - this._pausedAt) / 1000;
  }
  get position() {
    return this._position;
  }
  get buffering() {
    return this._buffering;
  }
  set buffering(buffering) {
    if (this._buffering === buffering) {
      return;
    }
    this._buffering = buffering;
    this.dispatchEvent(new ReadAloudEvent('BufferingChange', this._currentSegment));
  }
  get minutesRemaining() {
    return this.voice.minutesRemaining;
  }
  get hasStandardMinutesRemaining() {
    let {
      standardCreditsRemaining
    } = this.voice.provider;
    return standardCreditsRemaining !== null && standardCreditsRemaining > 0;
  }
  async refreshCreditsRemaining() {
    // No-op for non-remote controllers
  }
  async resetCredits() {
    // No-op for non-remote controllers
  }
  retry() {
    // No-op for non-remote controllers
  }
  syncActiveWordToPlayback() {
    // No-op for non-remote controllers (no word-level timestamps)
  }
  get error() {
    return this._error;
  }
  /**
   * Index into the active segment's timestamp array for the word currently
   * being spoken, or null if no word-level data is available. Updated by the
   * controller as audio plays.
   */
  activeTimestampIndex = null;
  get _currentSegment() {
    return this._segments[this._position];
  }
  getSegmentToAnnotate() {
    // If less than 50% and less than 3 seconds into the current segment, use the previous one
    if (this._segmentProgressFraction < 0.5 && this._segmentProgressSeconds < 3) {
      let previousIndex = this._position - 1;
      if (previousIndex >= 0) {
        return this._segments[previousIndex];
      }
    }
    return this._currentSegment ?? null;
  }
  constructor(voice, segments, backwardStopIndex, forwardStopIndex) {
    super();
    this.voice = voice;
    this.lang = voice.language;
    this._position = backwardStopIndex ?? 0;
    this._backwardStopIndex = backwardStopIndex;
    this._forwardStopIndex = forwardStopIndex;
    this._segments = segments;
  }
  _scheduleSpeak(delay) {
    this._delayTimeout = setTimeout(() => {
      this._delayTimeout = null;
      this._speak();
    }, delay);
  }
  dispatchEvent(event) {
    if (this._destroyed) {
      return false;
    }
    return super.dispatchEvent(event);
  }
  skipBack(granularity = 'paragraph', accelerate = false) {
    this.lastSkipGranularity = granularity;
    let delta = accelerate ? 5 : 1;
    let newPosition;
    if (granularity === 'sentence') {
      newPosition = this._position - delta;
    } else {
      newPosition = this._position;
      // Skip an extra paragraph back if we're mid-paragraph,
      // so paragraphs are treated as a single unit for skipping
      if (this._segments[newPosition]?.anchor !== 'paragraphStart') {
        delta++;
      }
      for (let i = 0; i < delta; i++) {
        let previousIndex = this._segments.slice(0, newPosition).findLastIndex(segment => segment.anchor === 'paragraphStart');
        if (previousIndex === -1) {
          newPosition = 0;
          break;
        }
        newPosition = previousIndex;
      }
    }
    this._skipTo(Math.max(newPosition, 0));
  }
  skipAhead(granularity = 'paragraph', accelerate = false) {
    this.lastSkipGranularity = granularity;
    let delta = accelerate ? 5 : 1;
    let newPosition;
    if (granularity === 'sentence') {
      newPosition = this._position + delta;
    } else {
      newPosition = this._position;
      for (let i = 0; i < delta; i++) {
        let nextIndex = this._segments.slice(newPosition + 1).findIndex(segment => segment.anchor === 'paragraphStart');
        if (nextIndex === -1) {
          newPosition = this._segments.length - 1;
          break;
        }
        newPosition = nextIndex + newPosition + 1;
      }
    }
    this._skipTo(Math.min(newPosition, this._segments.length - 1));
  }
  _skipTo(position) {
    this._clearDelayTimeout();
    this._position = position;
    this._stop();
    this.dispatchEvent(new ReadAloudEvent('ActiveSegmentChanging', this._currentSegment));
    this._speak('skip');
    if (this._paused) {
      this.dispatchEvent(new ReadAloudEvent('ActiveSegmentChange', this._currentSegment));
    }
  }
  destroy() {
    this._clearDelayTimeout();
    this._destroyed = true;
  }
  _clearDelayTimeout() {
    if (this._delayTimeout !== null) {
      clearTimeout(this._delayTimeout);
      this._delayTimeout = null;
    }
  }
  _handleSegmentStart(segment, index) {
    this._position = index;
    this.dispatchEvent(new ReadAloudEvent('ActiveSegmentChange', segment));
  }
  _handleSegmentEnd(segment, index) {
    // Don't dispatch ActiveSegmentChange if segment ended due to pause
    if (this._paused) {
      return;
    }
    this.lastSkipGranularity = null;
    this.dispatchEvent(new ReadAloudEvent('ActiveSegmentChanging', null));
    this.dispatchEvent(new ReadAloudEvent('ActiveSegmentChange', null));
    if (this._position === index) {
      if (this._forwardStopIndex !== null && this._position === this._forwardStopIndex - 1) {
        this._position = Math.min(this._position + 1, this._segments.length - 1);
        this._forwardStopIndex = null;
        this.dispatchEvent(new ReadAloudEvent('ActiveSegmentChanging', this._currentSegment));
        this.dispatchEvent(new ReadAloudEvent('ActiveSegmentChange', this._currentSegment));
        this.dispatchEvent(new ReadAloudEvent('Complete', null));
      } else if (this._position === this._segments.length - 1) {
        this._position = this._backwardStopIndex ?? 0;
        this.dispatchEvent(new ReadAloudEvent('Complete', null));
      } else {
        this._position++;
        let delay = this.voice.sentenceDelay;
        if (this._currentSegment?.anchor === 'paragraphStart') {
          delay += DELAY_PARAGRAPH;
        }
        this._scheduleSpeak(delay);
      }
    }
  }
}
class ReadAloudEvent extends Event {
  segment;
  constructor(type, segment) {
    super(type);
    this.segment = segment;
  }
}
;// ./src/common/lib/utilities.js
function isMac() {
  return !!navigator && /Mac/.test(navigator.platform);
}
function isLinux() {
  return !!navigator && /Linux/.test(navigator.platform);
}
function isWin() {
  return !!navigator && /Win/.test(navigator.platform);
}

// https://stackoverflow.com/a/9851769
let isFirefox = typeof InstallTrigger !== 'undefined';
let isSafari = /constructor/i.test(window.HTMLElement) || function (p) {
  return p.toString() === "[object SafariRemoteNotification]";
}(!window['safari'] || typeof safari !== 'undefined' && window['safari'].pushNotification) || !!navigator && navigator.userAgent.includes('Safari/') && !navigator.userAgent.includes('Chrome/');
function isTextBox(node) {
  return ['INPUT'].includes(node.nodeName) && node.type === 'text' || node.getAttribute('contenteditable') === 'true';
}
function pressedNextKey(event) {
  let {
    key
  } = event;
  return !window.rtl && key === 'ArrowRight' || window.rtl && key === 'ArrowLeft' || key === 'ArrowDown';
}
function pressedPreviousKey(event) {
  let {
    key
  } = event;
  return !window.rtl && key === 'ArrowLeft' || window.rtl && key === 'ArrowRight' || key === 'ArrowUp';
}

/**
 * Return a-z if 'key' is A-Z or 'code' is KeyA-KeyZ, and the 'key' wasn't already a-z.
 *
 * For keyboard layouts that have a-z characters (QWERTY, AZERTY, etc.) it returns
 * 'key', while for other layouts like Hebrew or Arabic it converts physical 'code' KeyA-KeyZ
 * to a-z character. On macOS Firefox does this by itself, while on Window it doesn't.
 *
 * It also lowercases A-Z because it's not always consistent
 *
 * @param key
 * @param code
 * @returns {string}
 */
function normalizeKey(key, code) {
  if (key.length === 1) {
    if ('A' <= key && key <= 'Z') {
      key = key.toLowerCase();
    }
    if ((key < 'a' || key > 'z') && code.length === 4 && code[3] >= 'A' && code[3] <= 'Z') {
      key = code[3].toLowerCase();
    }
  }
  return key;
}

/**
 * Key combination taking into account layout and modifier keys
 * @param {KeyboardEvent} event
 * @returns {string}
 */
function getKeyCombination(event) {
  let modifiers = [];
  if (event.metaKey && isMac()) {
    modifiers.push('Cmd');
  }
  if (event.ctrlKey) {
    modifiers.push('Ctrl');
  }
  if (event.altKey) {
    modifiers.push('Alt');
  }
  if (event.shiftKey) {
    modifiers.push('Shift');
  }
  let key = normalizeKey(event.key, event.code);
  if (key === ' ') {
    key = 'Space';
  }
  if (['Shift', 'Control', 'Meta', 'Alt'].includes(key)) {
    key = '';
  }

  // Combine the modifiers and the normalized key into a single string
  if (key) {
    modifiers.push(key);
  }
  return modifiers.join('-');
}

/**
 * Physical key combination
 * @param {KeyboardEvent} event
 * @returns {string}
 */
function getCodeCombination(event) {
  let modifiers = [];
  if (event.metaKey && isMac()) {
    modifiers.push('Cmd');
  }
  if (event.ctrlKey) {
    modifiers.push('Ctrl');
  }
  if (event.altKey) {
    modifiers.push('Alt');
  }
  if (event.shiftKey) {
    modifiers.push('Shift');
  }
  let {
    key,
    code
  } = event;
  if (['Shift', 'Control', 'Meta', 'Alt'].includes(key)) {
    code = '';
  }

  // Combine the modifiers and the normalized key into a single string
  if (code) {
    modifiers.push(code);
  }
  return modifiers.join('-');
}
function setCaretToEnd(target) {
  let range = document.createRange();
  let sel = window.getSelection();
  range.selectNodeContents(target);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  target.focus();
  range.detach();
}

// https://github.com/jashkenas/underscore/blob/master/underscore.js
// (c) 2009-2018 Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
// Underscore may be freely distributed under the MIT license.
// Returns a function, that, when invoked, will only be triggered at most once
// during a given window of time. Normally, the throttled function will run
// as much as it can, without ever going more than once per `wait` duration;
// but if you'd like to disable the execution on the leading edge, pass
// `{leading: false}`. To disable execution on the trailing edge, ditto.
// Note: The function is modified to support dynamic wait by accept a function as wait argument
function throttle(func, wait, options) {
  var context, args, result;
  var timeout = null;
  var previous = 0;
  if (!options) options = {};

  // Helper function to get the wait time dynamically
  var getWaitTime = function () {
    return typeof wait === 'function' ? wait() : wait;
  };
  var later = function () {
    previous = options.leading === false ? 0 : Date.now();
    timeout = null;
    result = func.apply(context, args);
    if (!timeout) context = args = null;
  };
  return function () {
    var now = Date.now();
    if (!previous && options.leading === false) previous = now;
    var remaining = getWaitTime() - (now - previous); // Use the helper function
    context = this;
    args = arguments;
    if (remaining <= 0 || remaining > getWaitTime()) {
      // Use the helper function
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      previous = now;
      result = func.apply(context, args);
      if (!timeout) context = args = null;
    } else if (!timeout && options.trailing !== false) {
      timeout = setTimeout(later, remaining);
    }
    return result;
  };
}
function positionsEqual(p1, p2) {
  if (Array.isArray(p1.rects) !== Array.isArray(p2.rects) || Array.isArray(p1.paths) !== Array.isArray(p2.paths)) {
    return false;
  }
  if (p1.pageIndex !== p2.pageIndex) {
    return false;
  }
  if (p1.rects) {
    return JSON.stringify(p1.rects) === JSON.stringify(p2.rects);
  } else if (p1.paths) {
    return JSON.stringify(p1.paths) === JSON.stringify(p2.paths);
  }
  return false;
}
function getImageDataURL(img) {
  var canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight);
  return canvas.toDataURL('image/png');
}
function getPopupCoordinatesFromClickEvent(event) {
  let x = event.clientX;
  let y = event.clientY;
  if (event.screenX) {
    return {
      x: event.clientX,
      y: event.clientY
    };
  } else {
    let br = event.currentTarget.getBoundingClientRect();
    return {
      x: br.left,
      y: br.bottom
    };
  }
}
function getDragMultiIcon() {
  let node = document.getElementById('drag-multi');
  if (!node) {
    node = document.createElement('div');
    node.id = 'drag-multi';
    document.body.appendChild(node);
  }
  return node;
}
function setMultiDragPreview(dataTransfer) {
  let icon = getDragMultiIcon();
  dataTransfer.setDragImage(icon, 0, 0);
}

// https://stackoverflow.com/a/25456134
function basicDeepEqual(x, y) {
  if (x === y) {
    return true;
  } else if (typeof x === 'object' && x != null && typeof y === 'object' && y !== null) {
    if (Object.keys(x).length !== Object.keys(y).length) {
      return false;
    }
    for (let prop in x) {
      if (y.hasOwnProperty(prop)) {
        if (!basicDeepEqual(x[prop], y[prop])) {
          return false;
        }
      } else {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 *
 * @param oldAnnotations
 * @param newAnnotations
 * @param viewOnly Get annotations that only affect view i.e. position or color changes
 * @returns {{deleted: *[], created: *[], updated: *[]}}
 */
function getAffectedAnnotations(oldAnnotations, newAnnotations, viewOnly) {
  let deleted = [];
  // Annotations that newly appeared or disappeared
  let ids = new Set(newAnnotations.map(x => x.id));
  for (let annotation of oldAnnotations) {
    if (!ids.has(annotation.id)) {
      deleted.push(annotation);
    }
  }
  let created = [];
  let updated = [];
  let refs = new Map(oldAnnotations.map(x => [x.id, x]));
  for (let newAnnotation of newAnnotations) {
    let oldAnnotation = refs.get(newAnnotation.id);
    if (!oldAnnotation) {
      created.push(newAnnotation);
    }
    // Annotation ref changed
    else if (newAnnotation !== oldAnnotation) {
      if (viewOnly) {
        if (newAnnotation.color !== oldAnnotation.color || newAnnotation.comment !== oldAnnotation.comment || !basicDeepEqual(newAnnotation.position, oldAnnotation.position)) {
          updated.push(newAnnotation);
        }
      } else {
        updated.push(newAnnotation);
      }
    }
  }
  return {
    created,
    updated,
    deleted
  };
}

/**
 * Wait until scroll is no longer being triggered
 * @param {Document | Element} container Scrollable container
 * @param {number} debounceTime For how long the scroll shouldn't be triggered
 * @returns {Promise<unknown>}
 */
function debounceUntilScrollFinishes(container, debounceTime = 100) {
  return new Promise(resolve => {
    let debounceTimeout;
    let resolveAndCleanup = () => {
      container.removeEventListener('scroll', scrollListener);
      clearTimeout(debounceTimeout);
      resolve();
    };
    let scrollListener = () => {
      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(resolveAndCleanup, debounceTime);
    };
    container.addEventListener('scroll', scrollListener);
    // Start the debounce timeout immediately
    debounceTimeout = setTimeout(resolveAndCleanup, debounceTime);
  });
}

// findLastIndex polyfill
if (!Array.prototype.findLastIndex) {
  Array.prototype.findLastIndex = function (callback, thisArg) {
    if (this == null) {
      throw new TypeError('"this" is null or not defined');
    }
    var o = Object(this);
    var len = o.length >>> 0;
    if (typeof callback !== 'function') {
      throw new TypeError('callback must be a function');
    }
    var k = len - 1;
    while (k >= 0) {
      var kValue = o[k];
      if (callback.call(thisArg, kValue, k, o)) {
        return k;
      }
      k--;
    }
    return -1;
  };
}
function sortTags(tags) {
  let collator = new Intl.Collator(['en-US'], {
    numeric: true,
    sensitivity: 'base'
  });
  tags.sort((a, b) => {
    if (!a.color && !b.color) return collator.compare(a.name, b.name);
    if (!a.color && !b.color) return -1;
    if (!a.color && b.color) return 1;
    return a.position - b.position;
  });
  return tags;
}

/**
 * @param {ColorScheme | null} colorScheme
 * @returns {ColorScheme}
 */
function getCurrentColorScheme(colorScheme) {
  if (colorScheme) {
    return colorScheme;
  }
  let darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  return darkModeMediaQuery.matches ? 'dark' : 'light';
}

/**
 * Determines whether to use dark or light mode based on background and foreground colors.
 * @param {string} bgColor - Hex color code for the background (e.g., "#FFFFFF").
 * @param {string} fgColor - Hex color code for the foreground (e.g., "#000000").
 * @returns {ColorScheme} - "dark" if dark mode is recommended, "light" otherwise.
 */
function getModeBasedOnColors(bgColor, fgColor) {
  // Helper to convert a hex color code to an array of RGB values
  function hexToRgbArray(hex) {
    const bigint = parseInt(hex.replace("#", ""), 16);
    return [bigint >> 16 & 255, bigint >> 8 & 255, bigint & 255];
  }

  // Helper to calculate luminance directly from RGB values
  function calculateLuminance([r, g, b]) {
    return [r, g, b].map(value => {
      const normalized = value / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
    }).reduce((luminance, channel, index) => {
      // Combine weighted luminance values
      const weights = [0.2126, 0.7152, 0.0722];
      return luminance + channel * weights[index];
    }, 0);
  }

  // Convert hex colors to RGB arrays and calculate their luminance
  const bgLuminance = calculateLuminance(hexToRgbArray(bgColor));
  const fgLuminance = calculateLuminance(hexToRgbArray(fgColor));

  // Determine and return mode based on luminance comparison
  return bgLuminance > fgLuminance ? "light" : "dark";
}

/**
 * Explicitly focus a given node within the view to force screen readers to move
 * their virtual cursors to that element. Screen readers just look at rendered content
 * so without this any navigation done via outline/Find in/page input in toolbar gets
 * undone by virtual cursor either remaining where it was or even jumping to the beginning of content.
 * @param target - node to focus from the view. Views keep track of it in _a11yVirtualCursorTarget obj.
 */
async function placeA11yVirtualCursor(target) {
  // Can't focus a textnode, so grab its parent (e.g. <p>)
  if (target?.nodeType === Node.TEXT_NODE) {
    target = target.parentNode;
  }
  if (!target) return;
  let doc = target.ownerDocument;
  if (!doc.defaultView.frameElement || doc.defaultView.frameElement.ownerDocument !== document) {
    throw new Error('Virtual cursor target must be inside view iframe');
  }
  let previousTarget = doc.querySelector('.a11y-cursor-target');

  // if the target did not change, do nothing
  if (target == previousTarget && doc.activeElement == target) return;
  // If focus is outside the iframe (e.g. in the Find popup), abort
  if (document.activeElement !== doc.defaultView.frameElement) {
    return;
  }
  // If something within the iframe is focused, abort
  if (doc.activeElement && doc.activeElement !== doc.body) {
    return;
  }
  // If text is selected, abort so we don't deselect it
  if (doc.getSelection() && !doc.getSelection().isCollapsed) {
    return;
  }
  let oldTabIndex = target.getAttribute('tabindex');
  function blurHandler() {
    if (oldTabIndex) {
      target.setAttribute('tabindex', oldTabIndex);
    } else {
      target.removeAttribute('tabindex');
    }
    target.classList.remove('a11y-cursor-target');
  }
  // Make it temporarily focusable
  target.setAttribute('tabindex', '-1');
  target.classList.add('a11y-cursor-target');
  target.focus({
    preventScroll: true,
    focusVisible: false
  });
  // Remove all a11y props if the element is blurred
  target.addEventListener('blur', blurHandler, {
    once: true
  });
  // Cleanup if the focus did not take
  if (doc.activeElement != target) {
    blurHandler({
      target
    });
  }
}
;// ./src/common/read-aloud/browser/controller.ts




// Track which controller instance last called speechSynthesis.speak(),
// so that other instances don't cancel its speech via the global
// speechSynthesis.cancel()
let lastSpeaker = null;
class BrowserReadAloudController extends ReadAloudController {
  _charIndex = 0;
  _segmentStartTime = null;
  _currentUtterance = null;
  get _segmentProgressFraction() {
    let segment = this._currentSegment;
    if (!segment || !segment.text.length) {
      return 0;
    }
    return this._charIndex / segment.text.length;
  }
  get _segmentProgressSeconds() {
    if (this._segmentStartTime === null) {
      return 0;
    }
    return (performance.now() - this._segmentStartTime) / 1000 * this._speed;
  }
  _speak = debounce(() => {
    // Detach the end handler from the previous utterance before
    // cancelling so that the end event fired by cancel() is ignored.
    if (this._currentUtterance) {
      this._currentUtterance.onend = null;
      this._currentUtterance = null;
    }

    // Only cancel speechSynthesis if we're the last controller to have
    // called speak(). window.speechSynthesis is global, so cancelling
    // unconditionally could kill speech by another controller
    // (like a sample controller) that was initialized while this
    // controller was still alive.
    if (lastSpeaker === this || lastSpeaker === null) {
      window.speechSynthesis.cancel();
    }

    // We don't use speechSynthesis.pause()/resume() because of poor browser support
    // (waking from sleep will unpause in Firefox, pausing before .speak()
    // has no effect in Chrome, ...)
    if (!this._paused) {
      let index = this._position;
      let segment = this._segments[index];
      if (segment) {
        // Create a fresh utterance each time so cancelled and new
        // end events are on separate objects.
        let utterance = new SpeechSynthesisUtterance(segment.text);
        utterance.voice = this.voice.impl;
        if (isMac()) {
          // macOS speech synthesis uses speeds in WPM. Firefox uses
          // (rate * 200 wpm), but the system default speed is 180 wpm.
          // Scale to match.
          utterance.rate = this._speed * 0.9;
        } else {
          utterance.rate = this._speed;
        }
        utterance.onstart = () => this._handleSegmentStart(segment, index);
        utterance.onend = () => this._handleSegmentEnd(segment, index);
        utterance.onboundary = event => this._charIndex = event.charIndex;
        this._currentUtterance = utterance;
        this.buffering = true;
        // eslint-disable-next-line @typescript-eslint/no-this-alias,consistent-this
        lastSpeaker = this;
        window.speechSynthesis.speak(utterance);
      }
    }
  });
  _stop() {
    if (this._currentUtterance) {
      this._currentUtterance.onend = null;
      this._currentUtterance = null;
    }
    if (lastSpeaker === this || lastSpeaker === null) {
      window.speechSynthesis.cancel();
    }
  }
  _handleSegmentStart(segment, index) {
    super._handleSegmentStart(segment, index);
    this._charIndex = 0;
    this._segmentStartTime = performance.now();
    this.buffering = false;
  }
  destroy() {
    super.destroy();
    this._speak.cancel();
    this._position = -1;
    if (this._currentUtterance) {
      this._currentUtterance.onend = null;
      this._currentUtterance = null;
    }
    if (lastSpeaker === this) {
      lastSpeaker = null;
      window.speechSynthesis.cancel();
    }
  }
}
;// ./src/common/read-aloud/browser/voice.ts



class BrowserReadAloudVoice extends ReadAloudVoice {
  get id() {
    return 'local-' + this.impl.voiceURI;
  }
  get label() {
    if (isMac()) {
      // Disambiguate macOS "Premium" voices from remote premium voices
      return this.impl.name.replace('(Premium)', '(macOS Premium)');
    }
    return this.impl.name;
  }
  get language() {
    return this.impl.lang;
  }
  get score() {
    // Safari claims *every* voice is the default, so just ignore that
    if (!isSafari && this.impl.default) {
      return 5;
    }

    // Use URIs to guess voice quality. This works well in Firefox and Safari
    // on macOS, but unfortunately Chrome (and Firefox on Windows) just use
    // the human-readable labels as "URIs." Nothing we can do there.

    // Best available voices
    if (this.impl.voiceURI.includes('com.apple.voice.premium')) {
      return 4;
    }
    // Pretty good voices
    if (this.impl.voiceURI.includes('com.apple.voice.enhanced')) {
      return 3;
    }
    // Decent voices
    if (this.impl.voiceURI.includes('com.apple.voice.compact')) {
      return 2;
    }
    // Antique voices (e.g. Zarvox)
    if (this.impl.voiceURI.includes('com.apple.speech')) {
      return 1;
    }
    // Everything else/other platforms
    return 1;
  }
  get segmentGranularity() {
    return 'sentence';
  }
  get creditsPerMinute() {
    return null;
  }
  get tier() {
    return 'local';
  }
  get default() {
    // TODO
    return true;
  }
  get sentenceDelay() {
    return 0;
  }
  getController(segments, backwardStopIndex, forwardStopIndex) {
    return new BrowserReadAloudController(this, segments, backwardStopIndex, forwardStopIndex);
  }
  getSampleController(segments) {
    return new BrowserReadAloudController(this, segments, null, null);
  }
}
;// ./src/common/read-aloud/browser/provider.ts

class BrowserReadAloudProvider {
  standardCreditsRemaining = null;
  premiumCreditsRemaining = null;
  async getVoices() {
    if (!window.speechSynthesis.getVoices().length) {
      await new Promise(resolve => {
        window.speechSynthesis.addEventListener('voiceschanged', resolve, {
          once: true
        });
      });
    }
    let voices = window.speechSynthesis.getVoices();
    // Safari returns duplicates
    let uniqueById = new Map();
    for (let voice of voices) {
      uniqueById.set(voice.voiceURI, voice);
    }
    return Array.from(uniqueById.values()).map(v => new BrowserReadAloudVoice(this, v)).sort((a, b) => b.score - a.score);
  }
}
;// ./src/common/lib/lru-cache-map.ts
class LRUCacheMap extends Map {
  _capacity;
  constructor(capacity = 500) {
    super();
    this._capacity = capacity;
  }
  get(key) {
    let value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }
  set(key, value) {
    if (super.has(key)) {
      super.delete(key);
    } else if (super.size === this._capacity) {
      super.delete(super.keys().next().value);
    }
    super.set(key, value);
    return this;
  }
}
;// ./src/common/read-aloud/remote/lib/time-stretch.ts
/**
 * WSOLA (Waveform Similarity Overlap-Add) time-stretching.
 *
 * Changes playback speed while preserving pitch by overlapping
 * windowed segments of the input, searching for the best alignment
 * within a tolerance window to minimize discontinuities.
 */
function stretchAudioBuffer(buffer, rate, context) {
  if (Math.abs(rate - 1) < 0.001) return buffer;
  let sampleRate = buffer.sampleRate;
  let numChannels = buffer.numberOfChannels;
  let inputLength = buffer.length;
  let outputLength = Math.round(inputLength / rate);

  // ~23ms window at 44.1kHz, power-of-2 for efficiency
  let windowSize = 1 << Math.round(Math.log2(sampleRate * 0.025));
  let synthesisHop = windowSize >> 1;
  let analysisHop = Math.round(synthesisHop * rate);
  let seekWindow = windowSize >> 2;
  let output = context.createBuffer(numChannels, outputLength, sampleRate);

  // Pre-compute Hann window
  let win = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (windowSize - 1)));
  }

  // Decimation factor for cross-correlation (4x faster, negligible quality loss)
  let corrDecimation = 4;
  let corrLength = Math.min(synthesisHop, windowSize);
  for (let ch = 0; ch < numChannels; ch++) {
    let inp = buffer.getChannelData(ch);
    let out = output.getChannelData(ch);

    // naturalPos tracks the ideal read position and always advances
    // by exactly analysisHop, so the search offset stays local to each
    // frame and can't accumulate across frames.
    let naturalPos = 0;
    let synthesisPos = 0;
    while (synthesisPos + windowSize <= outputLength && naturalPos + windowSize <= inputLength) {
      let bestPos = naturalPos;

      // After the first frame, search for the input position whose
      // overlap region best correlates with the existing output tail
      if (synthesisPos > 0) {
        let searchStart = Math.max(0, naturalPos - seekWindow);
        let searchEnd = Math.min(inputLength - windowSize, naturalPos + seekWindow);
        let bestCorr = -Infinity;
        for (let pos = searchStart; pos <= searchEnd; pos++) {
          let corr = 0;
          for (let i = 0; i < corrLength; i += corrDecimation) {
            corr += inp[pos + i] * out[synthesisPos + i];
          }
          if (corr > bestCorr) {
            bestCorr = corr;
            bestPos = pos;
          }
        }
      }

      // Overlap-add with Hann window
      for (let i = 0; i < windowSize; i++) {
        let outIdx = synthesisPos + i;
        let inIdx = bestPos + i;
        if (outIdx >= outputLength || inIdx >= inputLength) break;
        out[outIdx] += inp[inIdx] * win[i];
      }
      naturalPos += analysisHop;
      synthesisPos += synthesisHop;
    }
  }
  return output;
}
;// ./src/common/read-aloud/remote/lib/word-onset.ts
/**
 * Search backward from {@link position} for inter-word silences in the
 * audio, skipping back {@link wordBoundaries} word boundaries, and return
 * the onset of the next word (where energy rises again).
 * Falls back to the original position when no clear boundary is found.
 */
function findWordOnset(buffer, position, wordBoundaries = 1) {
  let sampleRate = buffer.sampleRate;
  let data = buffer.getChannelData(0);
  let posSample = Math.round(position * sampleRate);
  let windowLen = Math.round(sampleRate * 0.005); // 5ms energy windows
  let lookbackSamples = Math.round(sampleRate * 1.5 * wordBoundaries);
  let searchStart = Math.max(0, posSample - lookbackSamples);
  let numWindows = Math.floor((posSample - searchStart) / windowLen);
  if (numWindows < 3) return position;

  // Compute RMS energy per window
  let energies = new Float32Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    let start = searchStart + w * windowLen;
    let sum = 0;
    for (let i = 0; i < windowLen; i++) {
      let s = data[start + i] ?? 0;
      sum += s * s;
    }
    energies[w] = Math.sqrt(sum / windowLen);
  }

  // Use the 75th percentile of RMS as the reference — represents the
  // energy level of voiced speech, robust to silent stretches
  let sorted = Array.from(energies).sort((a, b) => a - b);
  let refRms = sorted[Math.floor(sorted.length * 0.75)];
  if (refRms === 0) return position;
  let threshold = refRms * 0.1;
  // Require at least 80ms of silence — long enough to rule out
  // intra-word consonant closures (typically 10-40ms)
  let minSilenceWindows = Math.round(0.08 / 0.005); // 16 windows

  // Search backward for runs of consecutive silent windows
  let boundariesFound = 0;
  let lastOnsetWindow = -1;
  let silenceEnd = -1;
  let silenceStart = -1;
  for (let w = numWindows - 1; w >= 0; w--) {
    if (energies[w] < threshold) {
      if (silenceEnd < 0) silenceEnd = w;
      silenceStart = w;
      if (silenceEnd - silenceStart + 1 >= minSilenceWindows) {
        boundariesFound++;
        // Find the word onset after this silence gap
        for (let ow = silenceEnd + 1; ow < numWindows; ow++) {
          if (energies[ow] >= threshold) {
            lastOnsetWindow = ow;
            break;
          }
        }
        if (boundariesFound >= wordBoundaries) {
          break;
        }
        // Continue searching backward from before this silence
        silenceEnd = -1;
        silenceStart = -1;
      }
    } else {
      silenceEnd = -1;
      silenceStart = -1;
    }
  }
  if (lastOnsetWindow >= 0) {
    return (searchStart + lastOnsetWindow * windowLen) / sampleRate;
  }
  return position;
}
;// ./src/common/read-aloud/remote/controller.ts





const AUDIO_BUFFER_CACHE_CAPACITY = 32;
const EST_PLAYBACK_CHARS_PER_SECOND = 16;
const EXP_MOVING_AVERAGE_ALPHA = 0.25;
const SKIP_DEBOUNCE_DELAY = 600;
const STALL_PROBE_DELAY_MS = 400;
class RemoteReadAloudControllerBase extends ReadAloudController {
  _audioContext;
  _filterChainInput;
  _sourceNode = null;
  _currentBuffer = null;
  _isPlaying = false;

  // AudioContext.currentTime when playback last started
  _playbackStartContextTime = 0;

  // Offset into the buffer (in seconds) when playback last started
  _playbackOffset = 0;

  // The rate passed to _playAudioBuffer, used to map progress back to
  // original-buffer time. The actual AudioBufferSourceNode always plays at 1x
  // because stretchAudioBuffer handles the speed change.
  _playbackRate = 1;

  // Word-level timestamps for the buffer currently being played, retained so
  // rescheduling on speed/device change can reuse them without a re-fetch.
  _currentTimestamps = null;

  // Active setTimeout handles for the word-onset events being scheduled
  // against the currently-playing buffer.
  _wordTimeouts = [];
  constructor(voice, segments, backwardStopIndex, forwardStopIndex) {
    super(voice, segments, backwardStopIndex, forwardStopIndex);
    this._initAudioContext();

    // Gecko on Windows doesn't transparently re-route an AudioContext's
    // output when the system default device changes (e.g., headphones
    // unplugged); the context stays bound to the removed sink and
    // playback goes silent. devicechange fires for all input/output
    // devices, so we only act if the context actually stops advancing
    navigator.mediaDevices?.addEventListener('devicechange', this._handleDeviceChange);
  }
  _initAudioContext() {
    // Build audio processing chain for speech clarity
    this._audioContext = new AudioContext();

    // Cut rumble and low-frequency noise below 80Hz
    let highpass = this._audioContext.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 80;
    highpass.Q.value = 0.7;

    // Gently peak around 3kHz to make speech clearer
    let presence = this._audioContext.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 3000;
    presence.gain.value = 3;
    presence.Q.value = 1;

    // Normalize volume across voices
    let compressor = this._audioContext.createDynamicsCompressor();
    highpass.connect(presence).connect(compressor).connect(this._audioContext.destination);
    this._filterChainInput = highpass;
  }
  _handleDeviceChange = () => {
    if (this._destroyed || !this._isPlaying || !this._currentBuffer) {
      return;
    }

    // Probe whether the sink actually died: sample currentTime now, and
    // after a short delay check whether it advanced. A healthy context
    // ticks currentTime continuously, but a context bound to a removed
    // sink stalls. This avoids spurious rebuilds on unrelated events.
    let sampledContext = this._audioContext;
    let sampledTime = sampledContext.currentTime;
    setTimeout(() => {
      // Destroyed, already rebuilt by a prior probe, or state changed out from under us
      if (this._destroyed || this._audioContext !== sampledContext || !this._isPlaying || !this._currentBuffer) {
        return;
      }
      // currentTime advanced, so the sink is still alive
      if (sampledContext.currentTime > sampledTime) {
        return;
      }
      let buffer = this._currentBuffer;
      let offset = this._currentPlaybackTime;
      let rate = this._playbackRate;
      let timestamps = this._currentTimestamps ?? undefined;
      this._stopSource();
      sampledContext.close();
      this._initAudioContext();
      this._playAudioBuffer(buffer, offset, rate, timestamps);
    }, STALL_PROBE_DELAY_MS);
  };

  // Progress is tracked in terms of the *original* (unstretched) buffer.
  // The stretched buffer plays at 1x, so elapsed real time = elapsed
  // stretched time. Multiply by the rate to map back to original time.
  get _currentPlaybackTime() {
    if (!this._isPlaying || !this._currentBuffer) {
      return this._playbackOffset;
    }
    let elapsed = (this._audioContext.currentTime - this._playbackStartContextTime) * this._playbackRate;
    return Math.min(this._playbackOffset + elapsed, this._currentBuffer.duration);
  }
  get _segmentProgressFraction() {
    if (!this._currentBuffer) return 0;
    return this._currentPlaybackTime / this._currentBuffer.duration;
  }
  get _segmentProgressSeconds() {
    return this._currentPlaybackTime;
  }
  get _currentBufferDuration() {
    return this._currentBuffer?.duration ?? 0;
  }
  async _decodeAudioData(blob) {
    let arrayBuffer = await blob.arrayBuffer();
    return this._audioContext.decodeAudioData(arrayBuffer);
  }
  _playAudioBuffer(buffer, offset, rate, timestamps) {
    this._stopSource();
    this._currentBuffer = buffer;
    this._playbackOffset = offset;
    this._playbackRate = rate;
    this._currentTimestamps = timestamps ?? null;

    // Time-stretch the buffer to change speed without affecting pitch.
    // AudioBufferSourceNode.playbackRate shifts pitch like a turntable,
    // so we stretch the buffer ourselves and always play at 1x.
    let stretched = stretchAudioBuffer(buffer, rate, this._audioContext);
    let stretchedOffset = offset / rate;
    let source = this._audioContext.createBufferSource();
    source.buffer = stretched;
    source.connect(this._filterChainInput);
    this._sourceNode = source;
    this._playbackStartContextTime = this._audioContext.currentTime;
    this._isPlaying = true;
    source.start(0, stretchedOffset);
    source.onended = () => {
      if (this._sourceNode !== source) return;
      this._isPlaying = false;
      this._clearWordSchedule();
      let segment = this._currentSegment;
      if (segment) {
        this._handleSegmentEnd(segment, this._position);
      }
    };
    if (timestamps?.length) {
      this._scheduleWordEvents(timestamps, offset, rate);
    }
  }
  _onSpeedChange() {
    if (this._isPlaying && this._currentBuffer) {
      let offset = this._currentPlaybackTime;
      let timestamps = this._currentTimestamps ?? undefined;
      this._stopSource();
      this._playAudioBuffer(this._currentBuffer, offset, this._speed, timestamps);
    }
  }
  _stop() {
    if (this._isPlaying) {
      this._playbackOffset = this._currentPlaybackTime;
    }
    this._stopSource();
  }
  _stopSource() {
    if (this._sourceNode) {
      this._sourceNode.onended = null;
      try {
        this._sourceNode.stop();
      } catch {
        // Already stopped
      }
      this._sourceNode.disconnect();
      this._sourceNode = null;
    }
    this._isPlaying = false;
    this._clearWordSchedule();
  }

  /**
   * Schedule a setTimeout for each timestamp boundary remaining after the
   * given offset. setTimeout() fires in wall-clock time, which matches audio
   * playback time at the AudioContext's 1x rate (we time-stretch the buffer
   * up front, so the source plays at 1x even when the user has set a higher
   * speed). Cleared by _clearWordSchedule() on any teardown of the source.
   */
  _scheduleWordEvents(timestamps, offset, rate) {
    for (let i = 0; i < timestamps.length; i++) {
      let timestamp = timestamps[i];
      if (timestamp.end <= offset) {
        continue;
      }
      let delayMs = Math.max(0, (timestamp.start - offset) / rate * 1000);
      let timeoutHandle = setTimeout(() => {
        if (this._destroyed) {
          return;
        }
        this.activeTimestampIndex = i;
        this.dispatchEvent(new ReadAloudEvent('ActiveWordChange', this._currentSegment));
      }, delayMs);
      this._wordTimeouts.push(timeoutHandle);
    }
  }

  /**
   * Cancel any pending word events. Leaves `activeTimestampIndex` alone --
   * the manager resets it on segment change, so on pause the highlight stays
   * on the word the user paused on.
   */
  _clearWordSchedule() {
    for (let timeoutHandle of this._wordTimeouts) {
      clearTimeout(timeoutHandle);
    }
    this._wordTimeouts.length = 0;
  }

  /**
   * Point activeTimestampIndex at the word playing at the current offset, so a
   * switch to word-level highlighting takes effect immediately instead of
   * waiting for the next scheduled word boundary.
   */
  syncActiveWordToPlayback() {
    let timestamps = this._currentTimestamps;
    if (!timestamps?.length || !this._isPlaying) {
      return;
    }
    let offset = this._segmentProgressSeconds;
    let index = timestamps.findIndex(timestamp => offset < timestamp.end);
    if (index < 0) {
      index = timestamps.length - 1;
    }
    if (this.activeTimestampIndex === index) {
      return;
    }
    this.activeTimestampIndex = index;
    this.dispatchEvent(new ReadAloudEvent('ActiveWordChange', this._currentSegment));
  }
  destroy() {
    super.destroy();
    navigator.mediaDevices?.removeEventListener('devicechange', this._handleDeviceChange);
    this._stopSource();
    this._audioContext.close();
  }
}
class RemoteReadAloudController extends RemoteReadAloudControllerBase {
  _currentIndex = null;
  _indexAtPause = null;
  _audioBuffers = new LRUCacheMap(AUDIO_BUFFER_CACHE_CAPACITY);
  _segmentTimestamps = new LRUCacheMap(AUDIO_BUFFER_CACHE_CAPACITY);
  _fetching = new Map();

  // Exponential moving average of time spent fetching per character (in milliseconds)
  _averageFetchTimePerChar = null;
  _failedIndices = new Set();
  _speak(cause) {
    if (cause === 'skip') {
      this._speakInternalWithSkipDebounce();
    } else {
      this._speakInternal();
    }
  }
  _speakInternal() {
    let indexAtPause = this._indexAtPause;
    // If we're pausing, capture current offset within the segment before disconnecting
    if (this._paused && this._currentIndex !== null) {
      this._indexAtPause = this._currentIndex;
    }
    if (this._paused) {
      this._stop();
      return;
    }
    let index = this._position;
    let segment = this._segments[index];
    if (!segment) {
      return;
    }
    let handleError = () => {
      if (this._position !== index) {
        return;
      }
      this.buffering = false;
      this._handleSegmentStart(segment, index);
      this.dispatchEvent(new ReadAloudEvent('Error', segment));
    };
    if (this._failedIndices.has(index)) {
      handleError();
      return;
    }
    this.buffering = true;
    this._getAudioData(index).then(audioBuffer => {
      if (this._position !== index) {
        return;
      }
      this.buffering = false;
      if (this._destroyed || this._paused) {
        return;
      }
      this._currentIndex = index;
      this._handleSegmentStart(segment, index);
      let offset;
      if (indexAtPause === index) {
        let pauseDuration = this._pauseDurationSeconds;
        if (pauseDuration < 5) {
          // Short pause (under 5 seconds): resume from exact position
          offset = this._segmentProgressSeconds;
        } else if (this.lang.startsWith('en')) {
          // Medium pause (5-20 seconds): jump back one word boundary
          // Long pause (20+ seconds): jump back two word boundaries
          let wordBoundaries = pauseDuration >= 20 ? 2 : 1;
          offset = findWordOnset(audioBuffer, this._segmentProgressSeconds, wordBoundaries);
        } else {
          offset = this._segmentProgressSeconds;
        }
      } else {
        offset = 0;
      }
      let timestamps = this._segmentTimestamps.get(index);
      this._playAudioBuffer(audioBuffer, offset, this._speed, timestamps);
      this._prefetchFrom(index + 1);
    }).catch(handleError);
  }
  _speakInternalWithSkipDebounce = debounce(() => this._speakInternal(), SKIP_DEBOUNCE_DELAY);
  async refreshCreditsRemaining() {
    let {
      standardCreditsRemaining,
      premiumCreditsRemaining
    } = await this.voice.provider.remote.getCreditsRemaining();
    if (standardCreditsRemaining !== null) {
      this.voice.provider.standardCreditsRemaining = standardCreditsRemaining;
    }
    if (premiumCreditsRemaining !== null) {
      this.voice.provider.premiumCreditsRemaining = premiumCreditsRemaining;
    }
  }
  async resetCredits() {
    let {
      standardCreditsRemaining,
      premiumCreditsRemaining
    } = await this.voice.provider.remote.resetCredits();
    if (standardCreditsRemaining !== null) {
      this.voice.provider.standardCreditsRemaining = standardCreditsRemaining;
    }
    if (premiumCreditsRemaining !== null) {
      this.voice.provider.premiumCreditsRemaining = premiumCreditsRemaining;
    }
  }
  retry() {
    let index = this._position;
    if (!this._failedIndices.has(index)) {
      return;
    }
    this._failedIndices.delete(index);
    this._error = null;
    this.dispatchEvent(new ReadAloudEvent('ErrorCleared', this._currentSegment));
    this._paused = false;
    this._speak();
  }
  async _prefetchFrom(startIndex) {
    const MAX_WINDOW = 3;
    const MAX_CONCURRENT_FETCHES = 2;
    let endIndex = Math.min(startIndex + MAX_WINDOW, this._forwardStopIndex ?? this._segments.length);
    if (startIndex >= endIndex) {
      return;
    }

    // Compute current time until each candidate starts, based on the real currentTime and estimates for upcoming
    let currentlyPlayingIndex = this._currentIndex ?? this._position;
    let currentTimeRemaining = Math.max(0, this._currentBufferDuration - this._segmentProgressSeconds);
    let prefixSums = [0];
    for (let i = currentlyPlayingIndex + 1; i < endIndex; i++) {
      let prev = prefixSums[prefixSums.length - 1];
      prefixSums.push(prev + this._estimatePlaybackTime(this._segments[i]));
    }
    let getTimeUntilStartOfSegment = i => {
      if (i <= currentlyPlayingIndex) return 0;
      let offset = i - (currentlyPlayingIndex + 1);
      let sumNext = offset >= 0 && offset < prefixSums.length ? prefixSums[offset] : 0;
      return (currentTimeRemaining + sumNext) * 1000;
    };

    // Assign a priority score to each candidate
    // Higher = fetch sooner
    let candidates = [];
    for (let i = startIndex; i < endIndex; i++) {
      let fetchTime = this._estimateFetchMs(this._segments[i]);
      let timeUntilStart = getTimeUntilStartOfSegment(i);
      let segmentsUntilStart = i - currentlyPlayingIndex;
      let risk = fetchTime - timeUntilStart;
      let segmentDistancePenalty = segmentsUntilStart * 50;
      let score = risk - segmentDistancePenalty;

      // Fetch the next segment first
      if (i === currentlyPlayingIndex + 1) {
        score += 10_000;
      }
      candidates.push({
        index: i,
        score
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    let numFetchesInProgress = 0;
    let keepFetching = async () => {
      if (this._destroyed || !candidates.length) return;
      let {
        index
      } = candidates.shift();
      numFetchesInProgress++;
      if (numFetchesInProgress < MAX_CONCURRENT_FETCHES) {
        keepFetching();
      }
      try {
        await this._getAudioData(index);
      } catch {
        // Ignore
      } finally {
        numFetchesInProgress--;
      }
      if (numFetchesInProgress < MAX_CONCURRENT_FETCHES) {
        keepFetching();
      }
    };

    // eslint-disable-next-line no-unmodified-loop-condition
    while (numFetchesInProgress < MAX_CONCURRENT_FETCHES && candidates.length) {
      keepFetching();
    }
  }
  async _getAudioData(index) {
    let cached = this._audioBuffers.get(index);
    if (cached) return cached;
    let inflight = this._fetching.get(index);
    if (inflight) return inflight;
    let segment = this._segments[index];
    let fetchAndDecode = async () => {
      let {
        audio,
        timestamps
      } = await this._fetchAudio(segment);
      let audioBuffer = await this._decodeAudioData(audio);
      this._audioBuffers.set(index, audioBuffer);
      if (timestamps) {
        this._segmentTimestamps.set(index, timestamps);
      }
      return audioBuffer;
    };
    inflight = fetchAndDecode().finally(() => this._fetching.delete(index));
    this._fetching.set(index, inflight);
    return inflight;
  }
  async _fetchAudio(segment) {
    let startTime = performance.now();
    let {
      audio,
      timestamps,
      error
    } = await this.voice.provider.remote.getAudio(segment, this.voice.impl);
    if (!audio) {
      if (error) {
        this._error = error;
        this._failedIndices.add(this._segments.indexOf(segment));
        console.error(error);
      }
      throw new Error('Failed to fetch audio');
    }

    // Update fetch time EMA, excluding outliers (e.g. cache hits that return near-instantly)
    if (segment.text.length) {
      let fetchTimePerChar = (performance.now() - startTime) / segment.text.length;
      if (this._averageFetchTimePerChar === null) {
        this._averageFetchTimePerChar = fetchTimePerChar;
      } else if (fetchTimePerChar > this._averageFetchTimePerChar * 0.1) {
        this._averageFetchTimePerChar = EXP_MOVING_AVERAGE_ALPHA * fetchTimePerChar + (1 - EXP_MOVING_AVERAGE_ALPHA) * this._averageFetchTimePerChar;
      }
    }
    return {
      audio,
      timestamps
    };
  }
  getTimestampsForSegment(segment) {
    let index = this._segments.indexOf(segment);
    if (index < 0) return null;
    return this._segmentTimestamps.get(index) ?? null;
  }
  _estimatePlaybackTime(segment) {
    let secsAt1x = segment.text.length / EST_PLAYBACK_CHARS_PER_SECOND;
    let secsAtCurrentSpeed = secsAt1x / this._speed;
    return Math.max(0.2, secsAtCurrentSpeed);
  }
  _estimateFetchMs(segment) {
    const LATENCY_PADDING_MS = 250;
    // Fallback when no data has been collected
    let perCharMs = this._averageFetchTimePerChar ?? 1.5;
    return LATENCY_PADDING_MS + perCharMs * segment.text.length;
  }
  destroy() {
    super.destroy();
    this._audioBuffers.clear();
    this._segmentTimestamps.clear();
    this._fetching.clear();
  }
}
class RemoteSampleReadAloudController extends RemoteReadAloudControllerBase {
  constructor(voice, segments) {
    super(voice, segments, null, null);
  }
  _speak() {
    if (this._paused) {
      this._stop();
      return;
    }
    let segment = this._segments[0];
    if (!segment) {
      return;
    }
    this._stop();
    this.buffering = true;
    this.voice.provider.remote.getAudio('sample', this.voice.impl).then(async ({
      audio,
      error
    }) => {
      this.buffering = false;
      if (this._destroyed || this._paused) {
        return;
      }
      if (audio) {
        let audioBuffer = await this._decodeAudioData(audio);
        this._handleSegmentStart(segment, 0);
        this._playAudioBuffer(audioBuffer, 0, this._speed);
      } else if (error) {
        console.error(error);
        this.dispatchEvent(new ReadAloudEvent('Error', segment));
      }
    }).catch(err => {
      this.buffering = false;
      console.error(err);
      this.dispatchEvent(new ReadAloudEvent('Error', segment));
    });
  }
}
;// ./src/common/read-aloud/remote/voice.ts


class RemoteReadAloudVoice extends ReadAloudVoice {
  get id() {
    return this.impl.id;
  }
  get label() {
    return this.impl.label;
  }
  get language() {
    return this.impl.locale;
  }
  get score() {
    if (this.id === 'openai') {
      return 998;
    }
    return 999;
  }
  get segmentGranularity() {
    return this.impl.segmentGranularity;
  }
  get creditsPerMinute() {
    return this.impl.creditsPerMinute;
  }
  get tier() {
    return this.impl.tier;
  }
  get default() {
    return true;
  }
  get sentenceDelay() {
    return this.impl.sentenceDelay ?? 0;
  }
  getController(segments, backwardStopIndex, forwardStopIndex) {
    return new RemoteReadAloudController(this, segments, backwardStopIndex, forwardStopIndex);
  }
  getSampleController(segments) {
    return new RemoteSampleReadAloudController(this, segments);
  }
}
;// ./src/common/read-aloud/remote/provider.ts


class RemoteVoicesError extends Error {
  errorState;
  constructor(errorState) {
    super(`Remote voices error: ${errorState}`);
    this.errorState = errorState;
    this.name = 'RemoteVoicesError';
  }
}
class RemoteReadAloudProvider {
  remote;
  standardCreditsRemaining = null;
  premiumCreditsRemaining = null;
  devMode = false;
  constructor(remote) {
    this.remote = remote;
  }
  async getVoices() {
    let {
      error,
      voices,
      standardCreditsRemaining,
      premiumCreditsRemaining,
      devMode
    } = await this.remote.getVoices();
    if (error || !voices) {
      throw new RemoteVoicesError(error || 'unknown');
    }
    if (standardCreditsRemaining !== null) {
      this.standardCreditsRemaining = standardCreditsRemaining;
    }
    if (premiumCreditsRemaining !== null) {
      this.premiumCreditsRemaining = premiumCreditsRemaining;
    }
    this.devMode = devMode;
    return parseVoicesResponse(voices).map(voice => new RemoteReadAloudVoice(this, voice));
  }
}

/**
 * Transform a format=2 voices response into a flat RemoteVoiceConfig array.
 * Each voice+locale combination produces a separate entry.
 */
function parseVoicesResponse(response) {
  let voices = [];
  for (let [tier, configs] of Object.entries(response)) {
    if (!Array.isArray(configs) || !TIERS.includes(tier)) continue;
    for (let config of configs) {
      for (let [locale, localeConfig] of Object.entries(config.locales || {})) {
        // Tolerate localeConfig being a plain array of IDs
        let ids = Array.isArray(localeConfig) ? localeConfig : [...localeConfig.default, ...(localeConfig.other ?? [])];
        for (let id of ids) {
          let voiceInfo = config.voices?.[id];
          if (!voiceInfo) continue;
          voices.push({
            id,
            label: voiceInfo.label,
            tier: tier,
            locale,
            creditsPerMinute: config.creditsPerMinute,
            segmentGranularity: config.segmentGranularity,
            sentenceDelay: config.sentenceDelay,
            cacheVersion: config.cacheVersion
          });
        }
      }
    }
  }
  return voices;
}
;// ./src/common/read-aloud/components/use-voice-data.ts






/**
 * Hook that loads all voices and manages language state.
 */
function useVoiceData({
  lang,
  remoteInterface
}) {
  let [allBrowserVoices, setAllBrowserVoices] = (0,external_React_.useState)(null);
  let [allRemoteVoices, setAllRemoteVoices] = (0,external_React_.useState)(null);
  let [browserVoicesError, setBrowserVoicesError] = (0,external_React_.useState)(null);
  let [remoteVoicesError, setRemoteVoicesError] = (0,external_React_.useState)(null);
  let [selectedLang, setSelectedLang] = (0,external_React_.useState)(lang);

  // Fetch browser voices
  (0,external_React_.useEffect)(() => {
    let cancelled = false;
    async function fetchVoices() {
      let browserProvider = new BrowserReadAloudProvider();
      try {
        let voices = await browserProvider.getVoices();
        if (!cancelled) {
          setAllBrowserVoices(voices);
          setBrowserVoicesError(null);
        }
      } catch (e) {
        if (!cancelled) {
          console.error(e);
          setAllBrowserVoices([]);
          setBrowserVoicesError('unknown');
        }
      }
    }
    fetchVoices();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch remote voices
  (0,external_React_.useEffect)(() => {
    if (!remoteInterface) return undefined;
    let cancelled = false;
    async function fetchVoices() {
      let remoteProvider = new RemoteReadAloudProvider(remoteInterface);
      try {
        let voices = await remoteProvider.getVoices();
        if (!cancelled) {
          setAllRemoteVoices(voices);
          setRemoteVoicesError(null);
        }
      } catch (e) {
        if (!cancelled) {
          console.error(e);
          setAllRemoteVoices([]);
          setRemoteVoicesError(e instanceof RemoteVoicesError ? e.errorState : 'unknown');
        }
      }
    }
    fetchVoices();
    return () => {
      cancelled = true;
    };
  }, [remoteInterface]);
  let loaded = allBrowserVoices !== null && (allRemoteVoices !== null || !remoteInterface);
  let allVoices = (0,external_React_.useMemo)(() => [...(allRemoteVoices || []), ...(allBrowserVoices || [])], [allRemoteVoices, allBrowserVoices]);
  let availableLanguages = (0,external_React_.useMemo)(() => getSupportedLanguages(allVoices), [allVoices]);

  // Resolve selectedLang if it's not in the available list
  // (e.g. base language "en" needs to resolve to "en-US")
  (0,external_React_.useEffect)(() => {
    if (availableLanguages.length && !availableLanguages.includes(selectedLang)) {
      let resolved = resolveLanguage(selectedLang, availableLanguages);
      if (resolved) {
        setSelectedLang(resolved);
      }
    }
  }, [availableLanguages, selectedLang]);
  return {
    allBrowserVoices,
    allRemoteVoices,
    allVoices,
    browserVoicesError,
    remoteVoicesError,
    loaded,
    selectedLang,
    availableLanguages,
    effectiveLang: selectedLang,
    handleLangChange: setSelectedLang
  };
}
;// ./src/common/read-aloud/components/use-sample-playback.js



/**
 * @returns {{
 *   playSample: (voice: ReadAloudVoice, lang: string) => void;
 *   stopSample: () => void;
 *   playing: boolean;
 *   buffering: boolean;
 * }}
 */
function useSamplePlayback() {
  const {
    l10n
  } = useLocalization();
  let [controller, setController] = (0,external_React_.useState)(null);
  let controllerRef = (0,external_React_.useRef)(null);
  controllerRef.current = controller;
  let [playing, setPlaying] = (0,external_React_.useState)(false);
  let [buffering, setBuffering] = (0,external_React_.useState)(false);
  (0,external_React_.useEffect)(() => {
    return () => {
      controllerRef.current?.destroy();
    };
  }, []);
  let playSample = (0,external_React_.useCallback)(voice => {
    if (!voice) {
      return;
    }
    controllerRef.current?.destroy();

    // Remove descriptors like "(Enhanced)" and "(English (UK))" from the label
    let name = voice.label.replace(/\(.+\)$/, '').trim();
    let text = l10n.getString('reader-read-aloud-sample-text', {
      name
    });
    let segments = [{
      text: text
    }];
    let newController = voice.getSampleController(segments);
    setController(newController);
    setPlaying(false);
    newController.addEventListener('BufferingChange', () => setBuffering(newController.buffering));
    newController.addEventListener('ActiveSegmentChange', ({
      segment
    }) => setPlaying(!!segment));
    newController.addEventListener('Complete', () => setPlaying(false));
    newController.paused = false;
  }, [l10n]);
  let stopSample = (0,external_React_.useCallback)(() => {
    if (!controllerRef.current) {
      return;
    }
    controllerRef.current.destroy();
    setController(null);
    setPlaying(false);
    setBuffering(false);
  }, []);
  return {
    playSample,
    stopSample,
    playing,
    buffering
  };
}
;// ./res/icons/16/loading.svg
var loading_path, _path2, _path3, _path4, _path5, _path6, _path7, _path8, _path9, _path10, _path11, _path12;
function loading_extends() { loading_extends = Object.assign ? Object.assign.bind() : function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return loading_extends.apply(this, arguments); }

const SvgLoading = props => /*#__PURE__*/external_React_.createElement("svg", loading_extends({
  xmlns: "http://www.w3.org/2000/svg",
  width: 16,
  height: 16,
  fill: "none"
}, props), loading_path || (loading_path = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  d: "M7 3V1s0-1 1-1 1 1 1 1v2s0 1-1 1-1-1-1-1"
})), _path2 || (_path2 = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  fillOpacity: 0.93,
  d: "m4.63 4.1-1-1.73S3.13 1.5 4 1c.87-.5 1.37.37 1.37.37l1 1.73s.5.87-.37 1.37c-.87.57-1.37-.37-1.37-.37"
})), _path3 || (_path3 = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  fillOpacity: 0.86,
  d: "m3.1 6.37-1.73-1S.5 4.87 1 4c.5-.87 1.37-.37 1.37-.37l1.73 1s.87.5.37 1.37c-.5.87-1.37.37-1.37.37"
})), _path4 || (_path4 = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  fillOpacity: 0.79,
  d: "M3 9H1S0 9 0 8s1-1 1-1h2s1 0 1 1-1 1-1 1"
})), _path5 || (_path5 = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  fillOpacity: 0.72,
  d: "m4.1 11.37-1.73 1S1.5 12.87 1 12c-.5-.87.37-1.37.37-1.37l1.73-1s.87-.5 1.37.37c.5.87-.37 1.37-.37 1.37"
})), _path6 || (_path6 = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  fillOpacity: 0.65,
  d: "m3.63 13.56 1-1.73s.5-.87 1.37-.37c.87.5.37 1.37.37 1.37l-1 1.73s-.5.87-1.37.37c-.87-.5-.37-1.37-.37-1.37"
})), _path7 || (_path7 = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  fillOpacity: 0.58,
  d: "M7 15v-2s0-1 1-1 1 1 1 1v2s0 1-1 1-1-1-1-1"
})), _path8 || (_path8 = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  fillOpacity: 0.51,
  d: "m10.63 14.56-1-1.73s-.5-.87.37-1.37c.87-.5 1.37.37 1.37.37l1 1.73s.5.87-.37 1.37c-.87.5-1.37-.37-1.37-.37"
})), _path9 || (_path9 = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  fillOpacity: 0.44,
  d: "m13.56 12.37-1.73-1s-.87-.5-.37-1.37c.5-.87 1.37-.37 1.37-.37l1.73 1s.87.5.37 1.37c-.5.87-1.37.37-1.37.37"
})), _path10 || (_path10 = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  fillOpacity: 0.37,
  d: "M15 9h-2s-1 0-1-1 1-1 1-1h2s1 0 1 1-1 1-1 1"
})), _path11 || (_path11 = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  fillOpacity: 0.3,
  d: "m14.56 5.37-1.73 1s-.87.5-1.37-.37c-.5-.87.37-1.37.37-1.37l1.73-1s.87-.5 1.37.37c.5.87-.37 1.37-.37 1.37"
})), _path12 || (_path12 = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  fillOpacity: 0.23,
  d: "m9.64 3.1.98-1.66s.5-.874 1.37-.37c.87.5.37 1.37.37 1.37l-1 1.73s-.5.87-1.37.37c-.87-.5-.37-1.37-.37-1.37z"
})));
/* harmony default export */ const loading = (SvgLoading);
;// ./res/icons/16/play-fill.svg
var play_fill_path;
function play_fill_extends() { play_fill_extends = Object.assign ? Object.assign.bind() : function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return play_fill_extends.apply(this, arguments); }

const SvgPlayFill = props => /*#__PURE__*/external_React_.createElement("svg", play_fill_extends({
  xmlns: "http://www.w3.org/2000/svg",
  width: 16,
  height: 16,
  fill: "none"
}, props), play_fill_path || (play_fill_path = /*#__PURE__*/external_React_.createElement("path", {
  fill: "currentColor",
  d: "M4.246 3.068c.152-.09.34-.09.492 0l7.675 4.5a.5.5 0 0 1 0 .865l-7.675 4.5a.486.486 0 0 1-.492 0A.502.502 0 0 1 4 12.501v-9c0-.179.094-.344.246-.433"
})));
/* harmony default export */ const play_fill = (SvgPlayFill);
;// ./src/common/components/modal-popup/read-aloud-voices-popup.js












function VoiceRow({
  voice,
  checked,
  onToggle,
  isActive,
  playing,
  buffering,
  onPlay
}) {
  return /*#__PURE__*/external_React_default().createElement("label", {
    className: "voice-row"
  }, /*#__PURE__*/external_React_default().createElement("input", {
    type: "checkbox",
    checked: checked,
    onChange: () => onToggle(voice.id)
  }), /*#__PURE__*/external_React_default().createElement("button", {
    className: classnames_default()('play-preview', {
      playing: isActive && (playing || buffering),
      buffering: isActive && buffering
    }),
    type: "button",
    onClick: e => {
      e.preventDefault();
      onPlay(voice);
    }
  }, isActive && buffering ? /*#__PURE__*/external_React_default().createElement(loading, null) : /*#__PURE__*/external_React_default().createElement(play_fill, null)), /*#__PURE__*/external_React_default().createElement("span", {
    className: "voice-label"
  }, voice.label));
}
const ReadAloudVoicesPopup = /*#__PURE__*/(0,external_React_.forwardRef)(function ReadAloudVoicesPopup({
  lang,
  tier: initialTier,
  remoteInterface,
  persistedEnabledVoices,
  onSetEnabledVoices,
  onCancel,
  onPurchaseCredits,
  onOpenVoicePreferences,
  standalone
}, ref) {
  const {
    l10n
  } = useLocalization();
  let [selectedTier, setSelectedTier] = (0,external_React_.useState)(initialTier || null);
  let [playingVoice, setPlayingVoice] = (0,external_React_.useState)(null);
  let {
    playSample,
    stopSample,
    playing,
    buffering
  } = useSamplePlayback();
  let {
    allVoices,
    loaded: voicesLoaded,
    selectedLang,
    availableLanguages,
    effectiveLang,
    enabledVoices,
    handleLangChange
  } = useVoiceData({
    lang,
    remoteInterface,
    persistedEnabledVoices
  });

  // Per-language checked voice state. Initialized lazily from defaults when
  // a language is first viewed. Only languages the user modifies are dirty.
  let [checkedByLang, setCheckedByLang] = (0,external_React_.useState)({});
  let [dirtyLangs, setDirtyLangs] = (0,external_React_.useState)(new Set());
  let defaultCheckedByTier = (0,external_React_.useMemo)(() => {
    if (!voicesLoaded) return null;
    let result = {};
    for (let tier of TIERS) {
      let tierVoices = getVoicesForLanguage(allVoices.filter(v => v.tier === tier), effectiveLang);
      result[tier] = new Set(resolveEnabledVoiceIDs(tierVoices, enabledVoices?.[tier]));
    }
    return result;
  }, [voicesLoaded, allVoices, effectiveLang, enabledVoices]);
  let checkedByTier = checkedByLang[selectedLang] || defaultCheckedByTier;
  function toggleVoice(tier, voiceID) {
    setCheckedByLang(prev => {
      let current = prev[selectedLang] || defaultCheckedByTier;
      let tierSet = new Set(current[tier]);
      if (tierSet.has(voiceID)) {
        tierSet.delete(voiceID);
      } else {
        tierSet.add(voiceID);
      }
      return {
        ...prev,
        [selectedLang]: {
          ...current,
          [tier]: tierSet
        }
      };
    });
    setDirtyLangs(prev => new Set(prev).add(selectedLang));
  }
  function getChanges() {
    let changes = {};
    for (let lang of dirtyLangs) {
      let langState = checkedByLang[lang];
      if (!langState) continue;
      changes[lang] = {};
      for (let tier of TIERS) {
        if (langState[tier]) {
          changes[lang][tier] = [...langState[tier]];
        }
      }
    }
    return changes;
  }
  let availableTiers = (0,external_React_.useMemo)(() => {
    let tiers = new Set(allVoices.map(v => v.tier));
    return TIERS.filter(t => tiers.has(t));
  }, [allVoices]);
  let voicesByTier = (0,external_React_.useMemo)(() => {
    let result = {};
    for (let tier of TIERS) {
      let tierVoices = allVoices.filter(v => v.tier === tier);
      result[tier] = getVoicesForLanguage(tierVoices, effectiveLang);
    }
    return result;
  }, [allVoices, effectiveLang]);

  // Auto-select first available tier
  (0,external_React_.useEffect)(() => {
    if (!selectedTier && availableTiers.length) {
      setSelectedTier(availableTiers[0]);
    }
  }, [availableTiers, selectedTier]);
  let voicesForTier = (0,external_React_.useMemo)(() => {
    let voices = voicesByTier[selectedTier] || [];
    // Sort by creditsPerMinute (ascending), preserving original order within same cost
    return [...voices].sort((a, b) => {
      let aCost = a.creditsPerMinute ?? -1;
      let bCost = b.creditsPerMinute ?? -1;
      return aCost - bCost;
    });
  }, [voicesByTier, selectedTier]);
  let checkedSet = checkedByTier?.[selectedTier] || new Set();
  function handlePlaySample(voice) {
    if ((playing || buffering) && playingVoice === voice) {
      stopSample();
      setPlayingVoice(null);
    } else {
      playSample(voice);
      setPlayingVoice(voice);
    }
  }

  // Use a ref so useImperativeHandle doesn't need dependencies
  let submitRef = (0,external_React_.useRef)();
  submitRef.current = () => {
    let changes = getChanges();
    if (Object.keys(changes).length > 0) {
      onSetEnabledVoices(changes);
    }
  };
  (0,external_React_.useImperativeHandle)(ref, () => ({
    submit: () => submitRef.current()
  }));
  function handleDone() {
    submitRef.current();
    onCancel();
  }
  let tierOptions = availableTiers.map(tier => ({
    value: tier,
    label: l10n.getString(`reader-read-aloud-voice-tier-${tier}`),
    disabled: !voicesByTier[tier]?.length
  }));
  if (!voicesLoaded) {
    return null;
  }
  let popupContent = /*#__PURE__*/external_React_default().createElement((external_React_default()).Fragment, null, /*#__PURE__*/external_React_default().createElement("div", {
    className: "content"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "main"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "header"
  }, tierOptions.length > 0 && /*#__PURE__*/external_React_default().createElement(custom_select, {
    "aria-label": l10n.getString('reader-read-aloud-voice-tier'),
    value: selectedTier || '',
    onChange: setSelectedTier,
    options: tierOptions
  }), /*#__PURE__*/external_React_default().createElement(language_region_select, {
    languages: availableLanguages,
    lang: selectedLang,
    onLangChange: handleLangChange
  })), /*#__PURE__*/external_React_default().createElement("div", {
    className: "voice-list"
  }, voicesForTier.map((voice, index) => {
    let prev = index > 0 ? voicesForTier[index - 1] : null;
    let showDivider = prev && voice.creditsPerMinute !== prev.creditsPerMinute;
    return /*#__PURE__*/external_React_default().createElement((external_React_default()).Fragment, {
      key: voice.id
    }, showDivider && /*#__PURE__*/external_React_default().createElement("div", {
      className: "divider"
    }), /*#__PURE__*/external_React_default().createElement(VoiceRow, {
      voice: voice,
      checked: checkedSet.has(voice.id),
      onToggle: id => toggleVoice(selectedTier, id),
      isActive: playingVoice === voice,
      playing: playing,
      buffering: buffering,
      onPlay: handlePlaySample
    }));
  }), voicesForTier.length === 0 && /*#__PURE__*/external_React_default().createElement("div", {
    className: "no-voices"
  }, l10n.getString('reader-read-aloud-voices-none-available'))), selectedTier === 'local' && /*#__PURE__*/external_React_default().createElement("button", {
    className: "get-more-voices",
    type: "button",
    onClick: onOpenVoicePreferences
  }, l10n.getString('reader-read-aloud-more-voices'))), /*#__PURE__*/external_React_default().createElement("div", {
    className: "description"
  }, selectedTier && /*#__PURE__*/external_React_default().createElement((external_React_default()).Fragment, null, /*#__PURE__*/external_React_default().createElement("div", {
    className: "tier-name"
  }, l10n.getString(`reader-read-aloud-voice-tier-${selectedTier}`)), /*#__PURE__*/external_React_default().createElement(BulletList, {
    tier: selectedTier,
    onPurchaseCredits: onPurchaseCredits
  })))), !standalone && /*#__PURE__*/external_React_default().createElement("div", {
    className: "row buttons"
  }, /*#__PURE__*/external_React_default().createElement("button", {
    className: "form-button",
    type: "button",
    onClick: onCancel
  }, l10n.getString('general-cancel')), /*#__PURE__*/external_React_default().createElement("button", {
    className: "form-button primary",
    type: "button",
    onClick: handleDone,
    disabled: checkedSet.size === 0
  }, l10n.getString('general-done'))));
  if (standalone) {
    return /*#__PURE__*/external_React_default().createElement("div", {
      className: "read-aloud-voices-popup standalone"
    }, popupContent);
  }
  return /*#__PURE__*/external_React_default().createElement(dialog_popup, {
    className: "read-aloud-voices-popup",
    onClose: onCancel
  }, popupContent);
});
/* harmony default export */ const read_aloud_voices_popup = (ReadAloudVoicesPopup);
;// ./node_modules/@fluent/bundle/esm/types.js
/**
 * The `FluentType` class is the base of Fluent's type system.
 *
 * Fluent types wrap JavaScript values and store additional configuration for
 * them, which can then be used in the `toString` method together with a proper
 * `Intl` formatter.
 */
class FluentType {
    /**
     * Create a `FluentType` instance.
     *
     * @param value The JavaScript value to wrap.
     */
    constructor(value) {
        this.value = value;
    }
    /**
     * Unwrap the raw value stored by this `FluentType`.
     */
    valueOf() {
        return this.value;
    }
}
/**
 * A {@link FluentType} representing no correct value.
 */
class FluentNone extends FluentType {
    /**
     * Create an instance of `FluentNone` with an optional fallback value.
     * @param value The fallback value of this `FluentNone`.
     */
    constructor(value = "???") {
        super(value);
    }
    /**
     * Format this `FluentNone` to the fallback string.
     */
    toString(scope) {
        return `{${this.value}}`;
    }
}
/**
 * A {@link FluentType} representing a number.
 *
 * A `FluentNumber` instance stores the number value of the number it
 * represents. It may also store an option bag of options which will be passed
 * to `Intl.NumerFormat` when the `FluentNumber` is formatted to a string.
 */
class FluentNumber extends FluentType {
    /**
     * Create an instance of `FluentNumber` with options to the
     * `Intl.NumberFormat` constructor.
     *
     * @param value The number value of this `FluentNumber`.
     * @param opts Options which will be passed to `Intl.NumberFormat`.
     */
    constructor(value, opts = {}) {
        super(value);
        this.opts = opts;
    }
    /**
     * Format this `FluentNumber` to a string.
     */
    toString(scope) {
        if (scope) {
            try {
                const nf = scope.memoizeIntlObject(Intl.NumberFormat, this.opts);
                return nf.format(this.value);
            }
            catch (err) {
                scope.reportError(err);
            }
        }
        return this.value.toString(10);
    }
}
/**
 * A {@link FluentType} representing a date and time.
 *
 * A `FluentDateTime` instance stores a Date object, Temporal object, or a number
 * as a numerical timestamp in milliseconds. It may also store an
 * option bag of options which will be passed to `Intl.DateTimeFormat` when the
 * `FluentDateTime` is formatted to a string.
 */
class FluentDateTime extends FluentType {
    static supportsValue(value) {
        if (typeof value === "number")
            return true;
        if (value instanceof Date)
            return true;
        if (value instanceof FluentType)
            return FluentDateTime.supportsValue(value.valueOf());
        // Temporary workaround to support environments without Temporal
        if ("Temporal" in globalThis) {
            // for TypeScript, which doesn't know about Temporal yet
            const _Temporal = globalThis.Temporal;
            if (value instanceof _Temporal.Instant ||
                value instanceof _Temporal.PlainDateTime ||
                value instanceof _Temporal.PlainDate ||
                value instanceof _Temporal.PlainMonthDay ||
                value instanceof _Temporal.PlainTime ||
                value instanceof _Temporal.PlainYearMonth) {
                return true;
            }
        }
        return false;
    }
    /**
     * Create an instance of `FluentDateTime` with options to the
     * `Intl.DateTimeFormat` constructor.
     *
     * @param value The number value of this `FluentDateTime`, in milliseconds.
     * @param opts Options which will be passed to `Intl.DateTimeFormat`.
     */
    constructor(value, opts = {}) {
        // unwrap any FluentType value, but only retain the opts from FluentDateTime
        if (value instanceof FluentDateTime) {
            opts = { ...value.opts, ...opts };
            value = value.value;
        }
        else if (value instanceof FluentType) {
            value = value.valueOf();
        }
        // Intl.DateTimeFormat defaults to gregorian calendar, but Temporal defaults to iso8601
        if (typeof value === "object" &&
            "calendarId" in value &&
            opts.calendar === undefined) {
            opts = { ...opts, calendar: value.calendarId };
        }
        super(value);
        this.opts = opts;
    }
    [Symbol.toPrimitive](hint) {
        return hint === "string" ? this.toString() : this.toNumber();
    }
    /**
     * Convert this `FluentDateTime` to a number.
     * Note that this isn't always possible due to the nature of Temporal objects.
     * In such cases, a TypeError will be thrown.
     */
    toNumber() {
        const value = this.value;
        if (typeof value === "number")
            return value;
        if (value instanceof Date)
            return value.getTime();
        if ("epochMilliseconds" in value) {
            return value.epochMilliseconds;
        }
        if ("toZonedDateTime" in value) {
            return value.toZonedDateTime("UTC").epochMilliseconds;
        }
        throw new TypeError("Unwrapping a non-number value as a number");
    }
    /**
     * Format this `FluentDateTime` to a string.
     */
    toString(scope) {
        if (scope) {
            try {
                const dtf = scope.memoizeIntlObject(Intl.DateTimeFormat, this.opts);
                return dtf.format(this.value);
            }
            catch (err) {
                scope.reportError(err);
            }
        }
        if (typeof this.value === "number" || this.value instanceof Date) {
            return new Date(this.value).toISOString();
        }
        return this.value.toString();
    }
}

;// ./node_modules/@fluent/bundle/esm/resolver.js
/**
 * The role of the Fluent resolver is to format a `Pattern` to an instance of
 * `FluentValue`. For performance reasons, primitive strings are considered
 * such instances, too.
 *
 * Translations can contain references to other messages or variables,
 * conditional logic in form of select expressions, traits which describe their
 * grammatical features, and can use Fluent builtins which make use of the
 * `Intl` formatters to format numbers and dates into the bundle's languages.
 * See the documentation of the Fluent syntax for more information.
 *
 * In case of errors the resolver will try to salvage as much of the
 * translation as possible. In rare situations where the resolver didn't know
 * how to recover from an error it will return an instance of `FluentNone`.
 *
 * All expressions resolve to an instance of `FluentValue`. The caller should
 * use the `toString` method to convert the instance to a native value.
 *
 * Functions in this file pass around an instance of the `Scope` class, which
 * stores the data required for successful resolution and error recovery.
 */

/**
 * The maximum number of placeables which can be expanded in a single call to
 * `formatPattern`. The limit protects against the Billion Laughs and Quadratic
 * Blowup attacks. See https://msdn.microsoft.com/en-us/magazine/ee335713.aspx.
 */
const MAX_PLACEABLES = 100;
/** Unicode bidi isolation characters. */
const FSI = "\u2068";
const PDI = "\u2069";
/** Helper: match a variant key to the given selector. */
function match(scope, selector, key) {
    if (key === selector) {
        // Both are strings.
        return true;
    }
    // XXX Consider comparing options too, e.g. minimumFractionDigits.
    if (key instanceof FluentNumber &&
        selector instanceof FluentNumber &&
        key.value === selector.value) {
        return true;
    }
    if (selector instanceof FluentNumber && typeof key === "string") {
        let category = scope
            .memoizeIntlObject(Intl.PluralRules, selector.opts)
            .select(selector.value);
        if (key === category) {
            return true;
        }
    }
    return false;
}
/** Helper: resolve the default variant from a list of variants. */
function getDefault(scope, variants, star) {
    if (variants[star]) {
        return resolvePattern(scope, variants[star].value);
    }
    scope.reportError(new RangeError("No default"));
    return new FluentNone();
}
/** Helper: resolve arguments to a call expression. */
function getArguments(scope, args) {
    const positional = [];
    const named = Object.create(null);
    for (const arg of args) {
        if (arg.type === "narg") {
            named[arg.name] = resolveExpression(scope, arg.value);
        }
        else {
            positional.push(resolveExpression(scope, arg));
        }
    }
    return { positional, named };
}
/** Resolve an expression to a Fluent type. */
function resolveExpression(scope, expr) {
    switch (expr.type) {
        case "str":
            return expr.value;
        case "num":
            return new FluentNumber(expr.value, {
                minimumFractionDigits: expr.precision,
            });
        case "var":
            return resolveVariableReference(scope, expr);
        case "mesg":
            return resolveMessageReference(scope, expr);
        case "term":
            return resolveTermReference(scope, expr);
        case "func":
            return resolveFunctionReference(scope, expr);
        case "select":
            return resolveSelectExpression(scope, expr);
        default:
            return new FluentNone();
    }
}
/** Resolve a reference to a variable. */
function resolveVariableReference(scope, { name }) {
    let arg;
    if (scope.params) {
        // We're inside a TermReference. It's OK to reference undefined parameters.
        if (Object.prototype.hasOwnProperty.call(scope.params, name)) {
            arg = scope.params[name];
        }
        else {
            return new FluentNone(`$${name}`);
        }
    }
    else if (scope.args &&
        Object.prototype.hasOwnProperty.call(scope.args, name)) {
        // We're in the top-level Pattern or inside a MessageReference. Missing
        // variables references produce ReferenceErrors.
        arg = scope.args[name];
    }
    else {
        scope.reportError(new ReferenceError(`Unknown variable: $${name}`));
        return new FluentNone(`$${name}`);
    }
    // Return early if the argument already is an instance of FluentType.
    if (arg instanceof FluentType) {
        return arg;
    }
    // Convert the argument to a Fluent type.
    switch (typeof arg) {
        case "string":
            return arg;
        case "number":
            return new FluentNumber(arg);
        case "object":
            if (FluentDateTime.supportsValue(arg)) {
                return new FluentDateTime(arg);
            }
        // eslint-disable-next-line no-fallthrough
        default:
            scope.reportError(new TypeError(`Variable type not supported: $${name}, ${typeof arg}`));
            return new FluentNone(`$${name}`);
    }
}
/** Resolve a reference to another message. */
function resolveMessageReference(scope, { name, attr }) {
    const message = scope.bundle._messages.get(name);
    if (!message) {
        scope.reportError(new ReferenceError(`Unknown message: ${name}`));
        return new FluentNone(name);
    }
    if (attr) {
        const attribute = message.attributes[attr];
        if (attribute) {
            return resolvePattern(scope, attribute);
        }
        scope.reportError(new ReferenceError(`Unknown attribute: ${attr}`));
        return new FluentNone(`${name}.${attr}`);
    }
    if (message.value) {
        return resolvePattern(scope, message.value);
    }
    scope.reportError(new ReferenceError(`No value: ${name}`));
    return new FluentNone(name);
}
/** Resolve a call to a Term with key-value arguments. */
function resolveTermReference(scope, { name, attr, args }) {
    const id = `-${name}`;
    const term = scope.bundle._terms.get(id);
    if (!term) {
        scope.reportError(new ReferenceError(`Unknown term: ${id}`));
        return new FluentNone(id);
    }
    if (attr) {
        const attribute = term.attributes[attr];
        if (attribute) {
            // Every TermReference has its own variables.
            scope.params = getArguments(scope, args).named;
            const resolved = resolvePattern(scope, attribute);
            scope.params = null;
            return resolved;
        }
        scope.reportError(new ReferenceError(`Unknown attribute: ${attr}`));
        return new FluentNone(`${id}.${attr}`);
    }
    scope.params = getArguments(scope, args).named;
    const resolved = resolvePattern(scope, term.value);
    scope.params = null;
    return resolved;
}
/** Resolve a call to a Function with positional and key-value arguments. */
function resolveFunctionReference(scope, { name, args }) {
    // Some functions are built-in. Others may be provided by the runtime via
    // the `FluentBundle` constructor.
    let func = scope.bundle._functions[name];
    if (!func) {
        scope.reportError(new ReferenceError(`Unknown function: ${name}()`));
        return new FluentNone(`${name}()`);
    }
    if (typeof func !== "function") {
        scope.reportError(new TypeError(`Function ${name}() is not callable`));
        return new FluentNone(`${name}()`);
    }
    try {
        let resolved = getArguments(scope, args);
        return func(resolved.positional, resolved.named);
    }
    catch (err) {
        scope.reportError(err);
        return new FluentNone(`${name}()`);
    }
}
/** Resolve a select expression to the member object. */
function resolveSelectExpression(scope, { selector, variants, star }) {
    let sel = resolveExpression(scope, selector);
    if (sel instanceof FluentNone) {
        return getDefault(scope, variants, star);
    }
    // Match the selector against keys of each variant, in order.
    for (const variant of variants) {
        const key = resolveExpression(scope, variant.key);
        if (match(scope, sel, key)) {
            return resolvePattern(scope, variant.value);
        }
    }
    return getDefault(scope, variants, star);
}
/** Resolve a pattern (a complex string with placeables). */
function resolveComplexPattern(scope, ptn) {
    if (scope.dirty.has(ptn)) {
        scope.reportError(new RangeError("Cyclic reference"));
        return new FluentNone();
    }
    // Tag the pattern as dirty for the purpose of the current resolution.
    scope.dirty.add(ptn);
    const result = [];
    // Wrap interpolations with Directional Isolate Formatting characters
    // only when the pattern has more than one element.
    const useIsolating = scope.bundle._useIsolating && ptn.length > 1;
    for (const elem of ptn) {
        if (typeof elem === "string") {
            result.push(scope.bundle._transform(elem));
            continue;
        }
        scope.placeables++;
        if (scope.placeables > MAX_PLACEABLES) {
            scope.dirty.delete(ptn);
            // This is a fatal error which causes the resolver to instantly bail out
            // on this pattern. The length check protects against excessive memory
            // usage, and throwing protects against eating up the CPU when long
            // placeables are deeply nested.
            throw new RangeError(`Too many placeables expanded: ${scope.placeables}, ` +
                `max allowed is ${MAX_PLACEABLES}`);
        }
        if (useIsolating) {
            result.push(FSI);
        }
        result.push(resolveExpression(scope, elem).toString(scope));
        if (useIsolating) {
            result.push(PDI);
        }
    }
    scope.dirty.delete(ptn);
    return result.join("");
}
/**
 * Resolve a simple or a complex Pattern to a FluentString
 * (which is really the string primitive).
 */
function resolvePattern(scope, value) {
    // Resolve a simple pattern.
    if (typeof value === "string") {
        return scope.bundle._transform(value);
    }
    return resolveComplexPattern(scope, value);
}

;// ./node_modules/@fluent/bundle/esm/scope.js
class Scope {
    constructor(bundle, errors, args) {
        /**
         * The Set of patterns already encountered during this resolution.
         * Used to detect and prevent cyclic resolutions.
         * @ignore
         */
        this.dirty = new WeakSet();
        /** A dict of parameters passed to a TermReference. */
        this.params = null;
        /**
         * The running count of placeables resolved so far.
         * Used to detect the Billion Laughs and Quadratic Blowup attacks.
         * @ignore
         */
        this.placeables = 0;
        this.bundle = bundle;
        this.errors = errors;
        this.args = args;
    }
    reportError(error) {
        if (!this.errors || !(error instanceof Error)) {
            throw error;
        }
        this.errors.push(error);
    }
    memoizeIntlObject(ctor, opts) {
        let cache = this.bundle._intls.get(ctor);
        if (!cache) {
            cache = {};
            this.bundle._intls.set(ctor, cache);
        }
        let id = JSON.stringify(opts);
        if (!cache[id]) {
            // @ts-expect-error This is fine.
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            cache[id] = new ctor(this.bundle.locales, opts);
        }
        return cache[id];
    }
}

;// ./node_modules/@fluent/bundle/esm/builtins.js
/**
 * @overview
 *
 * The FTL resolver ships with a number of functions built-in.
 *
 * Each function take two arguments:
 *   - args - an array of positional args
 *   - opts - an object of key-value args
 *
 * Arguments to functions are guaranteed to already be instances of
 * `FluentValue`.  Functions must return `FluentValues` as well.
 */

function values(opts, allowed) {
    const unwrapped = Object.create(null);
    for (const [name, opt] of Object.entries(opts)) {
        if (allowed.includes(name)) {
            unwrapped[name] = opt.valueOf();
        }
    }
    return unwrapped;
}
const NUMBER_ALLOWED = [
    "unitDisplay",
    "currencyDisplay",
    "useGrouping",
    "minimumIntegerDigits",
    "minimumFractionDigits",
    "maximumFractionDigits",
    "minimumSignificantDigits",
    "maximumSignificantDigits",
];
/**
 * The implementation of the `NUMBER()` builtin available to translations.
 *
 * Translations may call the `NUMBER()` builtin in order to specify formatting
 * options of a number. For example:
 *
 *     pi = The value of π is {NUMBER($pi, maximumFractionDigits: 2)}.
 *
 * The implementation expects an array of {@link FluentValue | FluentValues} representing the
 * positional arguments, and an object of named {@link FluentValue | FluentValues} representing the
 * named parameters.
 *
 * The following options are recognized:
 *
 *     unitDisplay
 *     currencyDisplay
 *     useGrouping
 *     minimumIntegerDigits
 *     minimumFractionDigits
 *     maximumFractionDigits
 *     minimumSignificantDigits
 *     maximumSignificantDigits
 *
 * Other options are ignored.
 *
 * @param args The positional arguments passed to this `NUMBER()`.
 * @param opts The named argments passed to this `NUMBER()`.
 */
function NUMBER(args, opts) {
    let arg = args[0];
    if (arg instanceof FluentNone) {
        return new FluentNone(`NUMBER(${arg.valueOf()})`);
    }
    if (arg instanceof FluentNumber) {
        return new FluentNumber(arg.valueOf(), {
            ...arg.opts,
            ...values(opts, NUMBER_ALLOWED),
        });
    }
    if (arg instanceof FluentDateTime) {
        return new FluentNumber(arg.toNumber(), {
            ...values(opts, NUMBER_ALLOWED),
        });
    }
    throw new TypeError("Invalid argument to NUMBER");
}
const DATETIME_ALLOWED = [
    "dateStyle",
    "timeStyle",
    "fractionalSecondDigits",
    "dayPeriod",
    "hour12",
    "weekday",
    "era",
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
    "timeZoneName",
];
/**
 * The implementation of the `DATETIME()` builtin available to translations.
 *
 * Translations may call the `DATETIME()` builtin in order to specify
 * formatting options of a number. For example:
 *
 *     now = It's {DATETIME($today, month: "long")}.
 *
 * The implementation expects an array of {@link FluentValue | FluentValues} representing the
 * positional arguments, and an object of named {@link FluentValue | FluentValues} representing the
 * named parameters.
 *
 * The following options are recognized:
 *
 *     dateStyle
 *     timeStyle
 *     fractionalSecondDigits
 *     dayPeriod
 *     hour12
 *     weekday
 *     era
 *     year
 *     month
 *     day
 *     hour
 *     minute
 *     second
 *     timeZoneName
 *
 * Other options are ignored.
 *
 * @param args The positional arguments passed to this `DATETIME()`.
 * @param opts The named argments passed to this `DATETIME()`.
 */
function DATETIME(args, opts) {
    let arg = args[0];
    if (arg instanceof FluentNone) {
        return new FluentNone(`DATETIME(${arg.valueOf()})`);
    }
    if (arg instanceof FluentDateTime || arg instanceof FluentNumber) {
        return new FluentDateTime(arg, values(opts, DATETIME_ALLOWED));
    }
    throw new TypeError("Invalid argument to DATETIME");
}

;// ./node_modules/@fluent/bundle/esm/memoizer.js
const cache = new Map();
function getMemoizerForLocale(locales) {
    const stringLocale = Array.isArray(locales) ? locales.join(" ") : locales;
    let memoizer = cache.get(stringLocale);
    if (memoizer === undefined) {
        memoizer = new Map();
        cache.set(stringLocale, memoizer);
    }
    return memoizer;
}

;// ./node_modules/@fluent/bundle/esm/bundle.js





/**
 * Message bundles are single-language stores of translation resources. They are
 * responsible for formatting message values and attributes to strings.
 */
class FluentBundle {
    /**
     * Create an instance of `FluentBundle`.
     *
     * @example
     * ```js
     * let bundle = new FluentBundle(["en-US", "en"]);
     *
     * let bundle = new FluentBundle(locales, {useIsolating: false});
     *
     * let bundle = new FluentBundle(locales, {
     *   useIsolating: true,
     *   functions: {
     *     NODE_ENV: () => process.env.NODE_ENV
     *   }
     * });
     * ```
     *
     * @param locales - Used to instantiate `Intl` formatters used by translations.
     * @param options - Optional configuration for the bundle.
     */
    constructor(locales, { functions, useIsolating = true, transform = (v) => v, } = {}) {
        /** @ignore */
        this._terms = new Map();
        /** @ignore */
        this._messages = new Map();
        this.locales = Array.isArray(locales) ? locales : [locales];
        this._functions = {
            NUMBER: NUMBER,
            DATETIME: DATETIME,
            ...functions,
        };
        this._useIsolating = useIsolating;
        this._transform = transform;
        this._intls = getMemoizerForLocale(locales);
    }
    /**
     * Check if a message is present in the bundle.
     *
     * @param id - The identifier of the message to check.
     */
    hasMessage(id) {
        return this._messages.has(id);
    }
    /**
     * Return a raw unformatted message object from the bundle.
     *
     * Raw messages are `{value, attributes}` shapes containing translation units
     * called `Patterns`. `Patterns` are implementation-specific; they should be
     * treated as black boxes and formatted with `FluentBundle.formatPattern`.
     *
     * @param id - The identifier of the message to check.
     */
    getMessage(id) {
        return this._messages.get(id);
    }
    /**
     * Add a translation resource to the bundle.
     *
     * @example
     * ```js
     * let res = new FluentResource("foo = Foo");
     * bundle.addResource(res);
     * bundle.getMessage("foo");
     * // → {value: .., attributes: {..}}
     * ```
     *
     * @param res
     * @param options
     */
    addResource(res, { allowOverrides = false, } = {}) {
        const errors = [];
        for (let i = 0; i < res.body.length; i++) {
            let entry = res.body[i];
            if (entry.id.startsWith("-")) {
                // Identifiers starting with a dash (-) define terms. Terms are private
                // and cannot be retrieved from FluentBundle.
                if (allowOverrides === false && this._terms.has(entry.id)) {
                    errors.push(new Error(`Attempt to override an existing term: "${entry.id}"`));
                    continue;
                }
                this._terms.set(entry.id, entry);
            }
            else {
                if (allowOverrides === false && this._messages.has(entry.id)) {
                    errors.push(new Error(`Attempt to override an existing message: "${entry.id}"`));
                    continue;
                }
                this._messages.set(entry.id, entry);
            }
        }
        return errors;
    }
    /**
     * Format a `Pattern` to a string.
     *
     * Format a raw `Pattern` into a string. `args` will be used to resolve
     * references to variables passed as arguments to the translation.
     *
     * In case of errors `formatPattern` will try to salvage as much of the
     * translation as possible and will still return a string. For performance
     * reasons, the encountered errors are not returned but instead are appended
     * to the `errors` array passed as the third argument.
     *
     * If `errors` is omitted, the first encountered error will be thrown.
     *
     * @example
     * ```js
     * let errors = [];
     * bundle.addResource(
     *     new FluentResource("hello = Hello, {$name}!"));
     *
     * let hello = bundle.getMessage("hello");
     * if (hello.value) {
     *     bundle.formatPattern(hello.value, {name: "Jane"}, errors);
     *     // Returns "Hello, Jane!" and `errors` is empty.
     *
     *     bundle.formatPattern(hello.value, undefined, errors);
     *     // Returns "Hello, {$name}!" and `errors` is now:
     *     // [<ReferenceError: Unknown variable: name>]
     * }
     * ```
     */
    formatPattern(pattern, args = null, errors = null) {
        // Resolve a simple pattern without creating a scope. No error handling is
        // required; by definition simple patterns don't have placeables.
        if (typeof pattern === "string") {
            return this._transform(pattern);
        }
        // Resolve a complex pattern.
        let scope = new Scope(this, errors, args);
        try {
            let value = resolveComplexPattern(scope, pattern);
            return value.toString(scope);
        }
        catch (err) {
            if (scope.errors && err instanceof Error) {
                scope.errors.push(err);
                return new FluentNone().toString(scope);
            }
            throw err;
        }
    }
}

;// ./node_modules/@fluent/bundle/esm/resource.js
// This regex is used to iterate through the beginnings of messages and terms.
// With the /m flag, the ^ matches at the beginning of every line.
const RE_MESSAGE_START = /^(-?[a-zA-Z][\w-]*) *= */gm;
// Both Attributes and Variants are parsed in while loops. These regexes are
// used to break out of them.
const RE_ATTRIBUTE_START = /\.([a-zA-Z][\w-]*) *= */y;
const RE_VARIANT_START = /\*?\[/y;
const RE_NUMBER_LITERAL = /(-?[0-9]+(?:\.([0-9]+))?)/y;
const RE_IDENTIFIER = /([a-zA-Z][\w-]*)/y;
const RE_REFERENCE = /([$-])?([a-zA-Z][\w-]*)(?:\.([a-zA-Z][\w-]*))?/y;
const RE_FUNCTION_NAME = /^[A-Z][A-Z0-9_-]*$/;
// A "run" is a sequence of text or string literal characters which don't
// require any special handling. For TextElements such special characters are: {
// (starts a placeable), and line breaks which require additional logic to check
// if the next line is indented. For StringLiterals they are: \ (starts an
// escape sequence), " (ends the literal), and line breaks which are not allowed
// in StringLiterals. Note that string runs may be empty; text runs may not.
const RE_TEXT_RUN = /([^{}\n\r]+)/y;
const RE_STRING_RUN = /([^\\"\n\r]*)/y;
// Escape sequences.
const RE_STRING_ESCAPE = /\\([\\"])/y;
const RE_UNICODE_ESCAPE = /\\u([a-fA-F0-9]{4})|\\U([a-fA-F0-9]{6})/y;
// Used for trimming TextElements and indents.
const RE_LEADING_NEWLINES = /^\n+/;
const RE_TRAILING_SPACES = / +$/;
// Used in makeIndent to strip spaces from blank lines and normalize CRLF to LF.
const RE_BLANK_LINES = / *\r?\n/g;
// Used in makeIndent to measure the indentation.
const RE_INDENT = /( *)$/;
// Common tokens.
const TOKEN_BRACE_OPEN = /{\s*/y;
const TOKEN_BRACE_CLOSE = /\s*}/y;
const TOKEN_BRACKET_OPEN = /\[\s*/y;
const TOKEN_BRACKET_CLOSE = /\s*] */y;
const TOKEN_PAREN_OPEN = /\s*\(\s*/y;
const TOKEN_ARROW = /\s*->\s*/y;
const TOKEN_COLON = /\s*:\s*/y;
// Note the optional comma. As a deviation from the Fluent EBNF, the parser
// doesn't enforce commas between call arguments.
const TOKEN_COMMA = /\s*,?\s*/y;
const TOKEN_BLANK = /\s+/y;
/**
 * Fluent Resource is a structure storing parsed localization entries.
 */
class FluentResource {
    constructor(source) {
        this.body = [];
        RE_MESSAGE_START.lastIndex = 0;
        let cursor = 0;
        // Iterate over the beginnings of messages and terms to efficiently skip
        // comments and recover from errors.
        while (true) {
            let next = RE_MESSAGE_START.exec(source);
            if (next === null) {
                break;
            }
            cursor = RE_MESSAGE_START.lastIndex;
            try {
                this.body.push(parseMessage(next[1]));
            }
            catch (err) {
                if (err instanceof SyntaxError) {
                    // Don't report any Fluent syntax errors. Skip directly to the
                    // beginning of the next message or term.
                    continue;
                }
                throw err;
            }
        }
        // The parser implementation is inlined below for performance reasons,
        // as well as for convenience of accessing `source` and `cursor`.
        // The parser focuses on minimizing the number of false negatives at the
        // expense of increasing the risk of false positives. In other words, it
        // aims at parsing valid Fluent messages with a success rate of 100%, but it
        // may also parse a few invalid messages which the reference parser would
        // reject. The parser doesn't perform any validation and may produce entries
        // which wouldn't make sense in the real world. For best results users are
        // advised to validate translations with the fluent-syntax parser
        // pre-runtime.
        // The parser makes an extensive use of sticky regexes which can be anchored
        // to any offset of the source string without slicing it. Errors are thrown
        // to bail out of parsing of ill-formed messages.
        function test(re) {
            re.lastIndex = cursor;
            return re.test(source);
        }
        // Advance the cursor by the char if it matches. May be used as a predicate
        // (was the match found?) or, if errorClass is passed, as an assertion.
        function consumeChar(char, errorClass) {
            if (source[cursor] === char) {
                cursor++;
                return true;
            }
            if (errorClass) {
                throw new errorClass(`Expected ${char}`);
            }
            return false;
        }
        // Advance the cursor by the token if it matches. May be used as a predicate
        // (was the match found?) or, if errorClass is passed, as an assertion.
        function consumeToken(re, errorClass) {
            if (test(re)) {
                cursor = re.lastIndex;
                return true;
            }
            if (errorClass) {
                throw new errorClass(`Expected ${re.toString()}`);
            }
            return false;
        }
        // Execute a regex, advance the cursor, and return all capture groups.
        function match(re) {
            re.lastIndex = cursor;
            let result = re.exec(source);
            if (result === null) {
                throw new SyntaxError(`Expected ${re.toString()}`);
            }
            cursor = re.lastIndex;
            return result;
        }
        // Execute a regex, advance the cursor, and return the capture group.
        function match1(re) {
            return match(re)[1];
        }
        function parseMessage(id) {
            let value = parsePattern();
            let attributes = parseAttributes();
            if (value === null && Object.keys(attributes).length === 0) {
                throw new SyntaxError("Expected message value or attributes");
            }
            return { id, value, attributes };
        }
        function parseAttributes() {
            let attrs = Object.create(null);
            while (test(RE_ATTRIBUTE_START)) {
                let name = match1(RE_ATTRIBUTE_START);
                let value = parsePattern();
                if (value === null) {
                    throw new SyntaxError("Expected attribute value");
                }
                attrs[name] = value;
            }
            return attrs;
        }
        function parsePattern() {
            let first;
            // First try to parse any simple text on the same line as the id.
            if (test(RE_TEXT_RUN)) {
                first = match1(RE_TEXT_RUN);
            }
            // If there's a placeable on the first line, parse a complex pattern.
            if (source[cursor] === "{" || source[cursor] === "}") {
                // Re-use the text parsed above, if possible.
                return parsePatternElements(first ? [first] : [], Infinity);
            }
            // RE_TEXT_VALUE stops at newlines. Only continue parsing the pattern if
            // what comes after the newline is indented.
            let indent = parseIndent();
            if (indent) {
                if (first) {
                    // If there's text on the first line, the blank block is part of the
                    // translation content in its entirety.
                    return parsePatternElements([first, indent], indent.length);
                }
                // Otherwise, we're dealing with a block pattern, i.e. a pattern which
                // starts on a new line. Discrad the leading newlines but keep the
                // inline indent; it will be used by the dedentation logic.
                indent.value = trim(indent.value, RE_LEADING_NEWLINES);
                return parsePatternElements([indent], indent.length);
            }
            if (first) {
                // It was just a simple inline text after all.
                return trim(first, RE_TRAILING_SPACES);
            }
            return null;
        }
        // Parse a complex pattern as an array of elements.
        function parsePatternElements(elements = [], commonIndent) {
            while (true) {
                if (test(RE_TEXT_RUN)) {
                    elements.push(match1(RE_TEXT_RUN));
                    continue;
                }
                if (source[cursor] === "{") {
                    elements.push(parsePlaceable());
                    continue;
                }
                if (source[cursor] === "}") {
                    throw new SyntaxError("Unbalanced closing brace");
                }
                let indent = parseIndent();
                if (indent) {
                    elements.push(indent);
                    commonIndent = Math.min(commonIndent, indent.length);
                    continue;
                }
                break;
            }
            let lastIndex = elements.length - 1;
            let lastElement = elements[lastIndex];
            // Trim the trailing spaces in the last element if it's a TextElement.
            if (typeof lastElement === "string") {
                elements[lastIndex] = trim(lastElement, RE_TRAILING_SPACES);
            }
            let baked = [];
            for (let element of elements) {
                if (element instanceof Indent) {
                    // Dedent indented lines by the maximum common indent.
                    element = element.value.slice(0, element.value.length - commonIndent);
                }
                if (element) {
                    baked.push(element);
                }
            }
            return baked;
        }
        function parsePlaceable() {
            consumeToken(TOKEN_BRACE_OPEN, SyntaxError);
            let selector = parseInlineExpression();
            if (consumeToken(TOKEN_BRACE_CLOSE)) {
                return selector;
            }
            if (consumeToken(TOKEN_ARROW)) {
                let variants = parseVariants();
                consumeToken(TOKEN_BRACE_CLOSE, SyntaxError);
                return {
                    type: "select",
                    selector,
                    ...variants,
                };
            }
            throw new SyntaxError("Unclosed placeable");
        }
        function parseInlineExpression() {
            if (source[cursor] === "{") {
                // It's a nested placeable.
                return parsePlaceable();
            }
            if (test(RE_REFERENCE)) {
                let [, sigil, name, attr = null] = match(RE_REFERENCE);
                if (sigil === "$") {
                    return { type: "var", name };
                }
                if (consumeToken(TOKEN_PAREN_OPEN)) {
                    let args = parseArguments();
                    if (sigil === "-") {
                        // A parameterized term: -term(...).
                        return { type: "term", name, attr, args };
                    }
                    if (RE_FUNCTION_NAME.test(name)) {
                        return { type: "func", name, args };
                    }
                    throw new SyntaxError("Function names must be all upper-case");
                }
                if (sigil === "-") {
                    // A non-parameterized term: -term.
                    return {
                        type: "term",
                        name,
                        attr,
                        args: [],
                    };
                }
                return { type: "mesg", name, attr };
            }
            return parseLiteral();
        }
        function parseArguments() {
            let args = [];
            while (true) {
                switch (source[cursor]) {
                    case ")": // End of the argument list.
                        cursor++;
                        return args;
                    case undefined: // EOF
                        throw new SyntaxError("Unclosed argument list");
                }
                args.push(parseArgument());
                // Commas between arguments are treated as whitespace.
                consumeToken(TOKEN_COMMA);
            }
        }
        function parseArgument() {
            let expr = parseInlineExpression();
            if (expr.type !== "mesg") {
                return expr;
            }
            if (consumeToken(TOKEN_COLON)) {
                // The reference is the beginning of a named argument.
                return {
                    type: "narg",
                    name: expr.name,
                    value: parseLiteral(),
                };
            }
            // It's a regular message reference.
            return expr;
        }
        function parseVariants() {
            let variants = [];
            let count = 0;
            let star;
            while (test(RE_VARIANT_START)) {
                if (consumeChar("*")) {
                    star = count;
                }
                let key = parseVariantKey();
                let value = parsePattern();
                if (value === null) {
                    throw new SyntaxError("Expected variant value");
                }
                variants[count++] = { key, value };
            }
            if (count === 0) {
                return null;
            }
            if (star === undefined) {
                throw new SyntaxError("Expected default variant");
            }
            return { variants, star };
        }
        function parseVariantKey() {
            consumeToken(TOKEN_BRACKET_OPEN, SyntaxError);
            let key;
            if (test(RE_NUMBER_LITERAL)) {
                key = parseNumberLiteral();
            }
            else {
                key = {
                    type: "str",
                    value: match1(RE_IDENTIFIER),
                };
            }
            consumeToken(TOKEN_BRACKET_CLOSE, SyntaxError);
            return key;
        }
        function parseLiteral() {
            if (test(RE_NUMBER_LITERAL)) {
                return parseNumberLiteral();
            }
            if (source[cursor] === '"') {
                return parseStringLiteral();
            }
            throw new SyntaxError("Invalid expression");
        }
        function parseNumberLiteral() {
            let [, value, fraction = ""] = match(RE_NUMBER_LITERAL);
            let precision = fraction.length;
            return {
                type: "num",
                value: parseFloat(value),
                precision,
            };
        }
        function parseStringLiteral() {
            consumeChar('"', SyntaxError);
            let value = "";
            while (true) {
                value += match1(RE_STRING_RUN);
                if (source[cursor] === "\\") {
                    value += parseEscapeSequence();
                    continue;
                }
                if (consumeChar('"')) {
                    return { type: "str", value };
                }
                // We've reached an EOL of EOF.
                throw new SyntaxError("Unclosed string literal");
            }
        }
        // Unescape known escape sequences.
        function parseEscapeSequence() {
            if (test(RE_STRING_ESCAPE)) {
                return match1(RE_STRING_ESCAPE);
            }
            if (test(RE_UNICODE_ESCAPE)) {
                let [, codepoint4, codepoint6] = match(RE_UNICODE_ESCAPE);
                let codepoint = parseInt(codepoint4 || codepoint6, 16);
                return codepoint <= 0xd7ff || 0xe000 <= codepoint
                    ? // It's a Unicode scalar value.
                        String.fromCodePoint(codepoint)
                    : // Lonely surrogates can cause trouble when the parsing result is
                        // saved using UTF-8. Use U+FFFD REPLACEMENT CHARACTER instead.
                        "�";
            }
            throw new SyntaxError("Unknown escape sequence");
        }
        // Parse blank space. Return it if it looks like indent before a pattern
        // line. Skip it othwerwise.
        function parseIndent() {
            let start = cursor;
            consumeToken(TOKEN_BLANK);
            // Check the first non-blank character after the indent.
            switch (source[cursor]) {
                case ".":
                case "[":
                case "*":
                case "}":
                case undefined: // EOF
                    // A special character. End the Pattern.
                    return false;
                case "{":
                    // Placeables don't require indentation (in EBNF: block-placeable).
                    // Continue the Pattern.
                    return makeIndent(source.slice(start, cursor));
            }
            // If the first character on the line is not one of the special characters
            // listed above, it's a regular text character. Check if there's at least
            // one space of indent before it.
            if (source[cursor - 1] === " ") {
                // It's an indented text character (in EBNF: indented-char). Continue
                // the Pattern.
                return makeIndent(source.slice(start, cursor));
            }
            // A not-indented text character is likely the identifier of the next
            // message. End the Pattern.
            return false;
        }
        // Trim blanks in text according to the given regex.
        function trim(text, re) {
            return text.replace(re, "");
        }
        // Normalize a blank block and extract the indent details.
        function makeIndent(blank) {
            let value = blank.replace(RE_BLANK_LINES, "\n");
            let length = RE_INDENT.exec(blank)[1].length;
            return new Indent(value, length);
        }
    }
}
class Indent {
    constructor(value, length) {
        this.value = value;
        this.length = length;
    }
}

;// ./node_modules/@fluent/bundle/esm/index.js
/**
 * A JavaScript implementation of Project Fluent, a localization
 * framework designed to unleash the expressive power of the natural language.
 *
 * @module
 */




;// ./src/fluent.js

let bundle = new FluentBundle('en-US', {
  functions: {
    PLATFORM: () => 'web'
  }
});
function getLocalizedString(key, args = {}) {
  const message = bundle.getMessage(key);
  if (message && message.value) {
    return bundle.formatPattern(message.value, args);
  } else {
    console.warn(`Localization key '${key}' not found`);
    return key;
  }
}
function addFTL(ftl) {
  bundle.addResource(new FluentResource(ftl), {
    allowOverrides: true
  });
}
;// ./src/common/lib/read-aloud-links.js

function getVoicePreferencesURL() {
  if (isMac()) {
    return 'x-apple.systempreferences:com.apple.preference.universalaccess?SpokenContent';
  } else if (isWin()) {
    return 'ms-settings:speech';
  } else if (isLinux()) {
    return 'https://github.com/brailcom/speechd';
  }
  return null;
}
;// ./src/index.read-aloud-voices.js







let l10n = new ReactLocalization([bundle]);
window.createReadAloudVoices = options => {
  if (Array.isArray(options.ftl)) {
    for (let ftl of options.ftl) {
      addFTL(ftl);
    }
  }
  function handleOpenVoicePreferences() {
    let url = getVoicePreferencesURL();
    if (url) {
      options.onOpenLink(url);
    }
  }
  let pendingResult = null;
  function handleSetEnabledVoices(enabledVoicesByLang) {
    pendingResult = enabledVoicesByLang;
  }
  let popupRef = /*#__PURE__*/(0,external_React_.createRef)();

  // Exposed for the parent dialog's accept button
  window.submit = () => {
    popupRef.current?.submit();
    return pendingResult;
  };
  (0,external_ReactDOM_.flushSync)(() => {
    (0,client/* createRoot */.H)(document.getElementById('read-aloud-voices')).render( /*#__PURE__*/external_React_default().createElement(LocalizationProvider, {
      l10n: l10n
    }, /*#__PURE__*/external_React_default().createElement(read_aloud_voices_popup, {
      ref: popupRef,
      standalone: true,
      lang: options.lang,
      tier: options.tier,
      remoteInterface: options.remoteInterface,
      persistedEnabledVoices: new Map(Object.entries(options.readAloudEnabledVoices || {})),
      onSetEnabledVoices: handleSetEnabledVoices,
      onCancel: options.onCancel,
      onPurchaseCredits: options.onPurchaseCredits,
      onOpenVoicePreferences: handleOpenVoicePreferences
    })));
  });
};
})();

/******/ 	return __webpack_exports__;
/******/ })()
;
});