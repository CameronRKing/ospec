"use strict"
/*
Ospec is made of four parts:

1. a test definition API That creates a spec/tests tree
2. a test runner that walks said spec tree
3. an assertion API that populates a results array
4. a reporter which presents the results

The temporal sequence at run time is 1 then (2 and 3), then 4

The various sections (and sub-sections thereof) share information through stack-managed globals
which are enumerated in the "Setup" section below.

there are three kind of data structures, that reflect the above segregation:

1. Specs, that group other specs and tasks
2. Tasks, that represent hooks and tests, and internal logic
3. Assertions which end up in the results array.

At run-time, the specs are converted to lists of task (one per entry in the spec)
In each of these tasks:
- sub-specs receive the same treament as their parent, when their turn comes.
- tests are also turned into lists of tasks [...beforeEach, test, ...afterEach]
*/


;(function(m) {
if (typeof module !== "undefined") module["exports"] = m()
else window.o = m()
})(function init(name) {
	// # Setup
	// const
	var hasProcess = typeof process === "object", hasOwn = ({}).hasOwnProperty
	var hasSuiteName = arguments.length !== 0
	var only = []
	var ospecFileName = getStackName(ensureStackTrace(new Error), /[\/\\](.*?):\d+:\d+/)
	var rootSpec = new Spec()
	var subjects = []

	// stack-managed globals
	var globalBail
	var globalContext = rootSpec
	var globalDepth = 1
	var globalFile
	var globalTestOrHook = null
	var globalTimeout = noTimeoutRightNow
	var globalTimedOutAndPendingResolution = 0

	// Shared state, set only once, but initialization is delayed
	var results, stats, timeoutStackName

	// # General utils
	function isRunning() {return results != null}

	function ensureStackTrace(error) {
		// mandatory to get a stack in IE 10 and 11 (and maybe other envs?)
		if (error.stack === undefined) try { throw error } catch(e) {return e}
		else return error
	}

	function getStackName(e, exp) {
		return e.stack && exp.test(e.stack) ? e.stack.match(exp)[1] : null
	}

	function noTimeoutRightNow() {
		throw new Error("`o.timeout()` must be called synchronously from within a test definition or a hook")
	}

	function timeoutParamDeprecationNotice(n) {
		console.error(new Error("`timeout()` as a test argument has been deprecated, use `o.timeout()`"))
		o.timeout(n)
	}

	// TODO: handle async functions?
	function validateDone(fn, error) {
		if (error == null || fn.length === 0) return
		var body = fn.toString()
		// Don't change the RegExp by hand, it is generated by
		// `scripts/build-done-parser.js`.
		// If needed, update the script and paste its output here.
		var arg = (body.match(/^(?:(?:function(?:\s|\/\*[^]*?\*\/|\/\/[^\n]*\n)*(?:\b[^\s(\/]+(?:\s|\/\*[^]*?\*\/|\/\/[^\n]*\n)*)?)?\((?:\s|\/\*[^]*?\*\/|\/\/[^\n]*\n)*)?([^\s{[),=\/]+)/) || []).pop()
		if (arg) {
			if(body.indexOf(arg) === body.lastIndexOf(arg)) {
				var doneError = new Error
				doneError.stack = "'" + arg + "()' should be called at least once\n" + o.cleanStackTrace(error)
				throw doneError
			}
		} else {
			console.warn("we couldn't determine the `done` callback name, please file a bug report at https://github.com/mithriljs/ospec/issues")
			arg = "done"
		}
		return "`" + arg + "()` should only be called once"
	}

	// # Spec definition
	function Spec() {
		this.before = []
		this.beforeEach = []
		this.after = []
		this.afterEach = []
		this.specTimeout = null
		this.customAssert = null
		this.children = Object.create(null)
	}

	// Used for both user-defined tests and internal book keeping
	// Internal tasks don't have an `err`. `hookName` is only defined
	// for hooks
	function Task(fn, err, hookName) {
		// This test needs to be here rather than in `o("name", test(){})`
		// in order to also cover nested hooks.
		if (isRunning() && err != null) throw new Error("Test definitions and hooks shouldn't be nested. To group tests, use 'o.spec()'")
		this.context = null
		this.file = globalFile
		// give tests an extra level of depth (simplifies bail out logic)
		this.depth = globalDepth + (hookName == null ? 1 : 0)
		this.doneTwiceError = validateDone(fn, err) || "A thenable should only be resolved once"
		this.error = err
		this.fn = fn
		this.hookName = hookName
	}

	function hook(name) {
		return function(predicate) {
			if (globalContext[name].length > 0) throw new Error("Attempt to register o." + name + "() more than once. A spec can only have one hook of each kind")
			globalContext[name][0] = new Task(predicate, ensureStackTrace(new Error), name)
		}
	}

	function unique(subject) {
		if (hasOwn.call(globalContext.children, subject)) {
			console.warn("A test or a spec named '" + subject + "' was already defined in this spec")
			console.warn(o.cleanStackTrace(ensureStackTrace(new Error)).split("\n")[0])
			while (hasOwn.call(globalContext.children, subject)) subject += "*"
		}
		return subject
	}

	// # API
	function o(subject, predicate) {
		if (predicate === undefined) {
			if (!isRunning()) throw new Error("Assertions should not occur outside test definitions")
			return new Assertion(subject)
		} else {
			subject = String(subject)
			globalContext.children[unique(subject)] = new Task(predicate, ensureStackTrace(new Error), null)
		}
	}

	/* minor addition: exposing spec tree to consumers */
	o.rootSpec = rootSpec;

	o.before = hook("before")
	o.after = hook("after")
	o.beforeEach = hook("beforeEach")
	o.afterEach = hook("afterEach")

	o.specTimeout = function (t) {
		if (isRunning()) throw new Error("o.specTimeout() can only be called before o.run()")
		if (globalContext.specTimeout != null) throw new Error("A default timeout has already been defined in this context")
		if (typeof t !== "number") throw new Error("o.specTimeout() expects a number as argument")
		globalContext.specTimeout = t
	}

	o.new = init

	o.spec = function(subject, predicate) {
		if (isRunning()) throw new Error("`o.spec()` can't only be called at test definition time, not run time")
		// stack managed globals
		var parent = globalContext
		var name = unique(subject)
		globalContext = globalContext.children[name] = new Spec()
		globalDepth++
		try {
			predicate()
		} catch(e) {
			console.error(e)
			globalContext.children[name].children = {"> > BAILED OUT < < <": new Task(function(){
				throw e
			}, ensureStackTrace(new Error), null)}
		}
		globalDepth--
		globalContext = parent
	}

	var onlyCalledAt = []
	o.only = function(subject, predicate) {
		onlyCalledAt.push(o.cleanStackTrace(ensureStackTrace(new Error)).split("\n")[0])
		only.push(predicate)
		o(subject, predicate)
	}

	o.cleanStackTrace = function(error) {
		// For IE 10+ in quirks mode, and IE 9- in any mode, errors don't have a stack
		if (error.stack == null) return ""
		var header = error.message ? error.name + ": " + error.message : error.name, stack
		// some environments add the name and message to the stack trace
		if (error.stack.indexOf(header) === 0) {
			stack = error.stack.slice(header.length).split(/\r?\n/)
			stack.shift() // drop the initial empty string
		} else {
			stack = error.stack.split(/\r?\n/)
		}
		if (ospecFileName == null) return stack.join("\n")
		// skip ospec-related entries on the stack
		return stack.filter(function(line) { return line.indexOf(ospecFileName) === -1 }).join("\n")
	}

	o.timeout = function(n) {
		globalTimeout(n)
	}

	// # Test runner
	var stack = []
	var scheduled = false
	function cycleStack() {
		try {
			while (stack.length) stack.shift()()
		} finally {
			// Don't stop on error, but still let it propagate to the host as usual.
			if (stack.length) setTimeout(cycleStack, 0)
			else scheduled = false
		}
	}
	/* eslint-disable indent */
	var nextTickish = hasProcess
		? process.nextTick
		: typeof Promise === "function"
		? Promise.prototype.then.bind(Promise.resolve())
		: function fakeFastNextTick(next) {
			if (!scheduled) {
				scheduled = true
				setTimeout(cycleStack, 0)
			}
			stack.push(next)
		}
	/* eslint-enable indent */
	o.metadata = function(opts) {
		if (arguments.length === 0) {
			if (!isRunning()) throw new Error("getting `o.metadata()` is only allowed at test run time")
			return {
				file: globalTestOrHook.file,
				name: globalTestOrHook.context
			}
		} else {
			if (isRunning() || globalContext !== rootSpec) throw new Error("setting `o.metadata()` is only allowed at the root, at test definition time")
			globalFile = opts.file
		}
	}
	o.run = function(reporter) {
		if (rootSpec !== globalContext) throw new Error("`o.run()` can't be called from within a spec")
		if (isRunning()) throw new Error("`o.run()` has already been called")
		results = []
		stats = {
			asyncSuccesses: 0,
			bailCount: 0,
			onlyCalledAt: onlyCalledAt
		}

		if (hasSuiteName) {
			var parent = new Spec()
			parent.children[name] = rootSpec
		}

		var finalize = new Task(function() {
			timeoutStackName = getStackName({stack: o.cleanStackTrace(ensureStackTrace(new Error))}, /([\w \.]+?:\d+:\d+)/)
			if (typeof reporter === "function") reporter(results, stats)
			else {
				var errCount = o.report(results, stats)
				if (hasProcess && errCount !== 0) process.exit(1) // eslint-disable-line no-process-exit
			}
		}, null, null)

		// always async for consistent external behavior
		// otherwise, an async test would release Zalgo
		// https://blog.izs.me/2013/08/designing-apis-for-asynchrony
		nextTickish(function () {
			runSpec(hasSuiteName ? parent : rootSpec, [], [], finalize, 200 /*default timeout delay*/)
		})

		function runSpec(spec, beforeEach, afterEach, finalize, defaultDelay) {
			var bailed = false
			if (spec.specTimeout) defaultDelay = spec.specTimeout

			// stack-managed globals
			var previousBail = globalBail
			globalBail = function() {bailed = true; stats.bailCount++}
			var restoreStack = new Task(function() {
				globalBail = previousBail
			}, null, null)

			beforeEach = [].concat(
				beforeEach,
				spec.beforeEach
			)
			afterEach = [].concat(
				spec.afterEach,
				afterEach
			)

			series(
				[].concat(
					spec.before,
					Object.keys(spec.children).reduce(function(tasks, key) {
						if (
							// If in `only` mode, skip the tasks that are not flagged to run.
							only.length === 0
							|| only.indexOf(spec.children[key].fn) !== -1
							// Always run specs though, in case there are `only` tests nested in there.
							|| !(spec.children[key] instanceof Task)
						) {
							tasks.push(new Task(function(done) {
								if (bailed) return done()
								o.timeout(Infinity)
								subjects.push(key)
								var popSubjects = new Task(function pop() {subjects.pop(), done()}, null, null)
								if (spec.children[key] instanceof Task) {
									// this is a test
									series(
										[].concat(beforeEach, spec.children[key], afterEach, popSubjects),
										defaultDelay
									)
								} else {
									// a spec...
									runSpec(spec.children[key], beforeEach, afterEach, popSubjects, defaultDelay)
								}
							}, null, null))
						}
						return tasks
					}, []),
					spec.after,
					restoreStack,
					finalize
				),
				defaultDelay
			)
		}

		// Executes a list of tasks in series.
		// This is quite convoluted because we handle both sync and async tasks.
		// Async tasks can either use a legacy `done(error?)` API, or return a
		// thenable, which may or may not behave like a Promise
		function series(tasks, defaultDelay) {
			var cursor = 0
			next()

			function next() {
				if (cursor === tasks.length) return

				// const
				var task = tasks[cursor++]
				var fn = task.fn
				var isHook = task.hookName != null
				var isInternal = task.error == null
				var taskStartTime = new Date

				// let
				var delay = defaultDelay
				var isAsync = false
				var isDone = false
				var isFinalized = false
				var timeout

				if (!isInternal) {
					globalTestOrHook = task
					task.context = subjects.join(" > ")
					if (isHook) {
						task.context = "o." + task.hookName + Array.apply(null, {length: task.depth}).join("*") + "( " + task.context + " )"
					}
				}
				globalTimeout = function timeout (t) {
					if (typeof t !== "number") throw new Error("timeout() and o.timeout() expect a number as argument")
					delay = t
				}

				try {
					if (fn.length > 0) {
						fn(done, timeoutParamDeprecationNotice)
					} else {
						var p = fn()
						if (p && p.then) {
							// Use `_done`, not `finalize` here to defend against badly behaved thenables.
							// Let it crash if `then()` doesn't work as expected.
							p.then(function() { _done(null, false) }, function(e) {_done(e, true)})
								.catch(err => finalize(err, true, false));
						} else {
							finalize(null, false, false)
						}
					}
					if (!isFinalized) {
						// done()/_done() haven't been called synchronously
						isAsync = true
						startTimer()
					}
				}
				catch (e) {
					if (isInternal) throw e
					else finalize(e, true, false)
				}
				globalTimeout = noTimeoutRightNow

				// public API, may only be called once from user code (or after the resolution
				// of a thenable that's been returned at the end of the test)
				function done(err) {
					// `!!err` would be more correct as far as node callback go, but we've been
					// using a `err != null` test for a while and no one complained...
					_done(err, err != null)
				}
				// common abstraction for node-style callbacks and thenables
				function _done(err, threw) {
					if (isDone) throw new Error(task.doneTwiceError)
					isDone = true
					if (isAsync && timeout === undefined) {
						globalTimedOutAndPendingResolution--
						console.warn(
							task.context
							+ "\n# elapsed: " + Math.round(new Date - taskStartTime)
							+ "ms, expected under " + delay + "ms\n"
							+ o.cleanStackTrace(task.error))
					}

					// temporary, for the "old style count" report
					if (!threw && task.error != null) {stats.asyncSuccesses++}

					if (!isFinalized) finalize(err, threw, false)
				}
				// called only for async tests
				function startTimer() {
					timeout = setTimeout(function() {
						timeout = undefined
						globalTimedOutAndPendingResolution++
						finalize("async test timed out after " + delay + "ms\nWarning: assertions starting with `???` may not be properly labelled", true, true)
					}, Math.min(delay, 0x7fffffff))
				}
				// common test finalization code path, for internal use only
				function finalize(err, threw, isTimeout) {
					if (isFinalized) {
						// failsafe for hacking, should never happen in released code
						throw new Error("Multiple finalization")
					}
					isFinalized = true

					if (threw) {
						if (err instanceof Error) fail(new Assertion().i, err.message, err)
						else fail(new Assertion().i, String(err), null)
						if (!isTimeout) {
							globalBail()
							if (task.hookName === "beforeEach") {
								while (tasks[cursor].error != null && tasks[cursor].depth > task.depth) cursor++
							}
						}
					}
					if (timeout !== undefined) timeout = clearTimeout(timeout)

					if (isAsync) next()
					else nextTickish(next)
				}
			}
		}
	}

	// #Assertions
	function Assertion(value) {
		this.value = value
		this.i = results.length
		results.push({
			pass: true, // incomplete assertions pass by default
			message: "Incomplete assertion in the test definition starting at...",
			error: globalTestOrHook.error,
			task: globalTestOrHook,
			timeoutLimbo: globalTimedOutAndPendingResolution === 0,
			// Deprecated
			context: (globalTimedOutAndPendingResolution === 0 ? "" : "??? ") + globalTestOrHook.context,
			testError: globalTestOrHook.error
		})
	}

	function plainAssertion(verb, compare) {
		return function(self, value, userMsg) {
			var success = compare(self.value, value)
			var message = serialize(self.value) + "\n  " + verb + "\n" + serialize(value)
			if (success) succeed(self.i, message, null)
			else throw new Error(userMsg ? userMsg : message); // fail(self.i, message, null)
		}
	}

	function define(name, assertion) {
		Assertion.prototype[name] = function assert(value, userMsg='') {
			assertion(this, value, userMsg)
		}
	}

	define("equals", plainAssertion("should equal", function(a, b) {return a === b}))
	define("notEquals", plainAssertion("should not equal", function(a, b) {return a !== b}))
	define("deepEquals", plainAssertion("should deep equal", deepEqual))
	define("notDeepEquals", plainAssertion("should not deep equal", function(a, b) {return !deepEqual(a, b)}))
	define("throws", plainAssertion("should throw a", throws))
	define("notThrows", plainAssertion("should not throw a", function(a, b) {return !throws(a, b)}))
	define("satisfies", function satisfies(self, check) {
		try {
			var res = check(self.value)
			if (res.pass) succeed(self.i, String(res.message), null)
			else fail(self.i, String(res.message), null)
		} catch (e) {
			results.pop()
			throw e
		}
	})
	define("notSatisfies", function notSatisfies(self, check) {
		try {
			var res = check(self.value)
			if (!res.pass) succeed(self.i, String(res.message), null)
			else fail(self.i, String(res.message), null)
		} catch (e) {
			results.pop()
			throw e
		}
	})

	function isArguments(a) {
		if ("callee" in a) {
			for (var i in a) if (i === "callee") return false
			return true
		}
	}

	function deepEqual(a, b) {
		if (a === b) return true
		if (a === null ^ b === null || a === undefined ^ b === undefined) return false // eslint-disable-line no-bitwise
		if (typeof a === "object" && typeof b === "object") {
			var aIsArgs = isArguments(a), bIsArgs = isArguments(b)
			if (a.constructor === Object && b.constructor === Object && !aIsArgs && !bIsArgs) {
				for (var i in a) {
					if ((!(i in b)) || !deepEqual(a[i], b[i])) return false
				}
				for (var i in b) {
					if (!(i in a)) return false
				}
				return true
			}
			if (a.length === b.length && (Array.isArray(a) && Array.isArray(b) || aIsArgs && bIsArgs)) {
				var aKeys = Object.getOwnPropertyNames(a), bKeys = Object.getOwnPropertyNames(b)
				if (aKeys.length !== bKeys.length) return false
				for (var i = 0; i < aKeys.length; i++) {
					if (!hasOwn.call(b, aKeys[i]) || !deepEqual(a[aKeys[i]], b[aKeys[i]])) return false
				}
				return true
			}
			if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
			if (typeof Buffer === "function" && a instanceof Buffer && b instanceof Buffer && a.length === b.length) {
				for (var i = 0; i < a.length; i++) {
					if (a[i] !== b[i]) return false
				}
				return true
			}
			if (a.valueOf() === b.valueOf()) return true
		}
		return false
	}

	function throws(a, b){
		try{
			a()
		}catch(e){
			if(typeof b === "string"){
				return (e.message === b)
			}else{
				return (e instanceof b)
			}
		}
		return false
	}

	function succeed(i, message, error) {
		var result = results[i]
		result.pass = true
		result.message = message
		// for notSatisfies. Use the task.error for other passing assertions
		if (error != null) result.error = error
	}

	function fail(i, message, error) {
		var result = results[i]
		result.pass = false
		result.message = message
		result.error = error != null ? error : ensureStackTrace(new Error)
	}

	function serialize(value) {
		if (hasProcess) return require("util").inspect(value) // eslint-disable-line global-require
		if (value === null || (typeof value === "object" && !(value instanceof Array)) || typeof value === "number") return String(value)
		else if (typeof value === "function") return value.name || "<anonymous function>"
		try {return JSON.stringify(value)} catch (e) {return String(value)}
	}

	// o.spy is functionally equivalent to this:
	// the extra complexity comes from compatibility issues
	// in ES5 environments where you can't overwrite fn.length

	// o.spy = function(fn) {
	// 	var spy = function() {
	// 		spy.this = this
	// 		spy.args = [].slice.call(arguments)
	// 		spy.calls.push({this: this, args: spy.args})
	// 		spy.callCount++

	// 		if (fn) return fn.apply(this, arguments)
	// 	}
	// 	if (fn)
	// 		Object.defineProperties(spy, {
	// 			length: {value: fn.length},
	// 			name: {value: fn.name}
	// 		})
	// 	spy.args = []
	// 	spy.calls = []
	// 	spy.callCount = 0
	// 	return spy
	// }

	var spyFactoryCache = Object.create(null)

	function makeSpyFactory(name, length) {
		if (spyFactoryCache[name] == null) spyFactoryCache[name] = []
		var args = Array.apply(null, {length: length}).map(
			function(_, i) {return "_" + i}
		).join(", ");
		var code =
			"'use strict';" +
			"var spy = (0, function " + name + "(" + args + ") {" +
			"   return helper(this, [].slice.call(arguments), fn, spy)" +
			"});" +
			"return spy"

		return spyFactoryCache[name][length] = new Function("fn", "helper", code)
	}

	function getOrMakeSpyFactory(name, length) {
		return spyFactoryCache[name] && spyFactoryCache[name][length] || makeSpyFactory(name, length)
	}

	function spyHelper(self, args, fn, spy) {
		spy.this = self
		spy.args = args
		spy.calls.push({this: self, args: args})
		spy.callCount++

		if (fn) return fn.apply(self, args)
	}

	var supportsFunctionMutations = false;
	// eslint-disable-next-line no-empty, no-implicit-coercion
	try {supportsFunctionMutations = !!Object.defineProperties(function(){}, {name: {value: "a"},length: {value: 1}})} catch(_){}

	var supportsEval = false
	// eslint-disable-next-line no-new-func, no-empty
	try {supportsEval = Function("return true")()} catch(e){}

	o.spy = function spy(fn) {
		var name = "", length = 0
		if (fn) name = fn.name, length = fn.length
		var spy = (!supportsFunctionMutations && supportsEval)
			? getOrMakeSpyFactory(name, length)(fn, spyHelper)
			: function(){return spyHelper(this, [].slice.call(arguments), fn, spy)}
		if (supportsFunctionMutations) Object.defineProperties(spy, {
			name: {value: name},
			length: {value: length}
		})

		spy.args = []
		spy.calls = []
		spy.callCount = 0
		return spy
	}

	// Reporter
	var colorCodes = {
		red: "31m",
		red2: "31;1m",
		green: "32;1m"
	}

	// console style for terminals
	// see https://stackoverflow.com/questions/4842424/list-of-ansi-color-escape-sequences
	function highlight(message, color) {
		var code = colorCodes[color] || colorCodes.red;
		return hasProcess ? (process.stdout.isTTY ? "\x1b[" + code + message + "\x1b[0m" : message) : "%c" + message + "%c "
	}

	// console style for the Browsers
	// see https://developer.mozilla.org/en-US/docs/Web/API/console#Styling_console_output
	function cStyle(color, bold) {
		return hasProcess||!color ? "" : "color:"+color+(bold ? ";font-weight:bold" : "")
	}

	function onlyWarning(onlyCalledAt) {
		var colors = Math.random() > 0.5
			? {
				term: "red2",
				web: cStyle("red", true)
			}
			: {
				term: "re",
				web: cStyle("red")
			}
		if (onlyCalledAt && onlyCalledAt.length !== 0) {
			console.warn(
				highlight("\nWarning: o.only() called...\n", colors.term),
				colors.web, ""
			)
			console.warn(onlyCalledAt.join("\n"))
			console.warn(
				highlight("\nWarning: o.only()\n", colors.term),
				colors.web, ""
			)
		}
	}

	o.report = function (results, stats) {
		if (stats == null) stats = {bailCount: 0, asyncSuccesses: 0}
		var errCount = -stats.bailCount
		for (var i = 0, r; r = results[i]; i++) {
			if (!r.pass) {
				var stackTrace = o.cleanStackTrace(r.error)
				var couldHaveABetterStackTrace = !stackTrace || timeoutStackName != null && stackTrace.indexOf(timeoutStackName) !== -1 && stackTrace.indexOf("\n") === -1
				if (couldHaveABetterStackTrace) stackTrace = r.task.error != null ? o.cleanStackTrace(r.task.error) : r.error.stack || ""
				console.error(
					(hasProcess ? "\n" : "") +
					(r.task.timeoutLimbo ? "??? " : "") +
					highlight(r.task.context + ":", "red2") + "\n" +
					highlight(r.message, "red") +
					(stackTrace ? "\n" + stackTrace + "\n" : ""),

					cStyle("black", true), cStyle(null), // reset to default
					cStyle("red"), cStyle("black")
				)
				errCount++
			}
		}
		var pl = results.length === 1 ? "" : "s"

		var oldTotal = " (old style total: " + (results.length + stats.asyncSuccesses) + ")"
		var total = results.length - stats.bailCount
		var message = [], log = []

		if (hasProcess) message.push("––––––\n")

		if (name) message.push(name + ": ")

		if (errCount === 0 && stats.bailCount === 0) {
			message.push(highlight((pl ? "All " : "The ") + total + " assertion" + pl + " passed" + oldTotal, "green"))
			log.push(cStyle("green" , true), cStyle(null))
		} else if (errCount === 0) {
			message.push((pl ? "All " : "The ") + total + " assertion" + pl + " passed" + oldTotal)
		} else {
			message.push(highlight(errCount + " out of " + total + " assertion" + pl + " failed" + oldTotal, "red2"))
			log.push(cStyle("red" , true), cStyle(null))
		}

		if (stats.bailCount !== 0) {
			message.push(highlight(". Bailed out " + stats.bailCount + (stats.bailCount === 1 ? " time" : " times"), "red"))
			log.push(cStyle("red"), cStyle(null))
		}

		log.unshift(message.join(""))
		console.log.apply(console, log)

		onlyWarning(stats.onlyCalledAt)

		return errCount + stats.bailCount
	}
	return o
})
