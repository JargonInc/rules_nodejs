(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    /**
     * Tsetse rules should extend AbstractRule and provide a `register` function.
     * Rules are instantiated once per compilation operation and used across many
     * files.
     */
    class AbstractRule {
    }
    exports.AbstractRule = AbstractRule;
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicnVsZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uLy4uLy4uL2V4dGVybmFsL2J1aWxkX2JhemVsX3J1bGVzX3R5cGVzY3JpcHQvaW50ZXJuYWwvdHNldHNlL3J1bGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7SUFFQTs7OztPQUlHO0lBQ0gsTUFBc0IsWUFBWTtLQVFqQztJQVJELG9DQVFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHtDaGVja2VyfSBmcm9tICcuL2NoZWNrZXInO1xuXG4vKipcbiAqIFRzZXRzZSBydWxlcyBzaG91bGQgZXh0ZW5kIEFic3RyYWN0UnVsZSBhbmQgcHJvdmlkZSBhIGByZWdpc3RlcmAgZnVuY3Rpb24uXG4gKiBSdWxlcyBhcmUgaW5zdGFudGlhdGVkIG9uY2UgcGVyIGNvbXBpbGF0aW9uIG9wZXJhdGlvbiBhbmQgdXNlZCBhY3Jvc3MgbWFueVxuICogZmlsZXMuXG4gKi9cbmV4cG9ydCBhYnN0cmFjdCBjbGFzcyBBYnN0cmFjdFJ1bGUge1xuICBhYnN0cmFjdCByZWFkb25seSBydWxlTmFtZTogc3RyaW5nO1xuICBhYnN0cmFjdCByZWFkb25seSBjb2RlOiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFJlZ2lzdGVycyBoYW5kbGVyIGZ1bmN0aW9ucyBvbiBub2RlcyBpbiBDaGVja2VyLlxuICAgKi9cbiAgYWJzdHJhY3QgcmVnaXN0ZXIoY2hlY2tlcjogQ2hlY2tlcik6IHZvaWQ7XG59XG4iXX0=