/*
  mustache.js — Logic-less templates in JavaScript

  See http://mustache.github.com/ for more info.
*/

var DrawMustache = function(options) {
  var otag      = options['otag'];
  var ctag      = options['ctag'];
  var translate = options['translate'];

  var pragmas             = {};
  var pragmas_implemented = {
    "IMPLICIT-ITERATOR": true,
    "TRANSLATION-HINT": true
  }
  var compiled_templates  = {};

  var pragma_regexp, i18n_regexp, contains_sections_regexp, otag_regexp, tag_regexp, section_regexp;
  function set_regexps() {
    pragma_regexp            = new RegExp(otag + "%([\\w-]+) ?([\\w]+=[\\w]+)?" + ctag);
    i18n_regexp              = new RegExp(otag + "\\_i" + ctag + "\\s*([\\s\\S]+?)" + otag + "\\/i" + ctag, "mg");
    contains_sections_regexp = new RegExp(otag + "[#\^]");
    otag_regexp              = new RegExp(otag);
    tag_regexp               = new RegExp("^([\\s\\S]*?)" + otag + "(=|!|>|\\{|%)?([^\\/#\\^]+?)\\1?" + ctag + "+\([\\s\\S]*)$");
    section_regexp           = new RegExp(
      "^([\\s\\S]*?)" +          // all the crap at the beginning that is not {{*}} ($1)
      otag +                     // {{
      "(\\^|\\#)\\s*(.+)\\s*" +  //  #foo (# == $2, foo == $3)
      ctag +                     // }}
      "\n*([\\s\\S]*?)" +        // between the tag ($2). leading newlines are dropped
      otag +                     // {{
      "\\/\\s*\\3\\s*" +         //  /foo (backreference to the opening tag).
      ctag +                     // }}
      "\\s*([\\s\\S]*)$"         // everything else in the string ($4). leading whitespace is dropped.
    )
  }
  set_regexps();

  var renderer = {
    render: function(template, global_context, partial_context, partials) {
      var compiled_template = compiled_templates[template];
      if (compiled_template == null) {
        compiled_template = compile_template(template, partials);
        compiled_templates[template] = compiled_template;
      }
      return compiled_template.call(this, global_context, partial_context, partials);
    },

    render_section: function(buff, value, content, global_context, partial_context, partials) {
      var iterator = ".";
      if (pragmas["IMPLICIT-ITERATOR"]) {
        iterator = pragmas["IMPLICIT-ITERATOR"].iterator;
      }

      if (this.is_array(value)) { // Enumerable, Let's loop!
        for (var i = 0; i < value.length; i++) {
          var iterator_context = {};
          iterator_context[iterator] = value[i];
          buff = buff.concat(
            this.render(
              content,
              global_context,
              this.is_object(value[i]) ? value[i] : iterator_context,
              partials))
        }
      } else if (this.is_object(value)) { // Object, Use it as subcontext!
        buff = buff.concat(this.render(content, global_context, value, partials))
      } else if (typeof value === "function") { // higher order section
        var that = this;
        buff = buff.concat(value.call(partial_context || global_context, content, function(text) {
          return that.render(text, global_context, partial_context, partials);
        }))
      } else if (value) { // boolean section
        buff = buff.concat(this.render(content, global_context, partial_context, partials));
      }
      return buff;
    },

    /* find me a value from the view object. */
    find: function(name, partial_context, global_context) {
      name = trim(name);

      // Checks whether a value is thruthy or false or 0
      function is_kinda_truthy(bool) {
        return bool === false || bool === 0 || bool;
      }

      var value;
      if (partial_context && is_kinda_truthy(partial_context[name])) {
        value = partial_context[name];
      } else if (is_kinda_truthy(global_context[name])) {
        value = global_context[name];
      }

      if (typeof value === "function") {
        return value.apply(partial_context || global_context);
      }
      if (value !== undefined) {
        return value;
      }
      // silently ignore unkown variables
      return "";
    },

    is_object: function(a) {
      return a && typeof a == "object";
    },

    is_array: function(a) {
      return Object.prototype.toString.call(a) === '[object Array]';
    },

    escape_html: function(s) {
      s = String(s === null ? "" : s);
      return s.replace(/&(?!\w+;)|["'<>\\]/g, function(s) {
        switch(s) {
        case "&": return "&amp;";
        case '"': return '&quot;';
        case "'": return '&#39;';
        case "<": return "&lt;";
        case ">": return "&gt;";
        default: return s;
        }
      })
    }
  };

  function to_js_string_literal(str) {
    str = str.replace(/"/g, "\\\"");
    str = str.replace(/\n/g, "\\n");
    return str;
  }

  /* Gets rid of leading and trailing whitespace */
  function trim(s) {
    return s.replace(/^\s*|\s*$/g, "");
  };

  function compile_template(template, partials) {
    if (!template.match(otag_regexp)) {
      return function() { return template };
    }

    var compiled_template = compile_sections_and_tags(template, partials);
    var function_body =
      "var buff = '';\n" +
      compiled_template + "\n" +
      "return buff;";
    return new Function("global_context", "partial_context", "partials", function_body);
  };

  function compile_sections_and_tags(template, partials) {
    template = precompile_pragmas(template);
    template = precompile_i18n(template);

    var compiled_template;
    if (template.match(contains_sections_regexp)) {
      compiled_template = compile_sections(template, partials);
    } else {
      compiled_template = compile_tags(template, partials);
    }

    return compiled_template;
  };

  function precompile_pragmas(template) {
    return template.replace(pragma_regexp, function(match, pragma, options) {
      if (!pragmas_implemented[pragma]) {
        throw({message: "This implementation of mustache doesn't understand the '" + pragma + "' pragma"});
      }
      pragmas[pragma] = {};
      if (options) {
        var opts = options.split("=");
        pragmas[pragma][opts[0]] = opts[1];
      }
      return "";
      // ignore unknown pragmas silently
    })
  };

  function precompile_i18n(template) {
    var translation_mode = "";
    if (pragmas && pragmas["TRANSLATION-HINT"] && pragmas["TRANSLATION-HINT"].mode) {
      translation_mode = pragmas["TRANSLATION-HINT"].mode;
    }

    return template.replace(i18n_regexp, function(match, content) {
      var params = {
        text: content,
        mode: translation_mode
      };
      return translate(params);
    });
  };

  /* Renders inverted (^) and normal (#) sections */
  function compile_sections(template, partials) {
    return template.replace(section_regexp, function(match, before, type, name, content, after) {
      var compiled_before = before ? compile_tags(before, partials) : "";
      var compiled_after = after ? compile_sections_and_tags(after, partials) : "";
      var compiled_content = "";

      compiled_content = compiled_content.concat(
        "var value = this.find(\"" + name + "\", partial_context, global_context);\n" +
        "var content = \"" + to_js_string_literal(content) + "\";\n");

      if (type === "^") { // inverted section
        compiled_content = compiled_content.concat(
          "if (!value || this.is_array(value) && value.length === 0) {\n" +
            compile_sections_and_tags(content, partials) + // false or empty list, render it
          "}"
        )
      } else if (type === "#") { // normal section
        var iterator = ".";
        if (pragmas["IMPLICIT-ITERATOR"]) {
          iterator = pragmas["IMPLICIT-ITERATOR"].iterator;
        }

        compiled_content = compiled_content.concat(
          "buff = this.render_section(buff, value, content, global_context, partial_context, partials);\n"
        )
      }

      return compiled_before + compiled_content + compiled_after;
    })
  };


  /* Replace {{foo}} and friends with values from our view */
  function compile_tags(template, partials) {
    if (!template.match(otag_regexp)) {
      return "buff = buff.concat(\"" + to_js_string_literal(template) + "\");\n"
    }

    return template.replace(tag_regexp, function(match, before, operator, name, after) {
      var compiled_before  = before ? "buff = buff.concat(\"" + to_js_string_literal(before) + "\");\n" : "";
      var compiled_after   = after ? compile_tags(after, partials) : "";
      var compiled_content = "";

      switch (operator) {
      case "!": // ignore comments
        break;
      case "=": // set new delimiters, rebuild the replace regexp
        set_delimiters(name);
        break;
      case ">": // render partial
        compiled_content =
          "var potential_context_for_partial = this.find(\"" + name + "\", partial_context, global_context);\n" +
          "var context_for_partial = this.is_object(potential_context_for_partial) ? potential_context_for_partial : partial_context;\n" +
          "buff = buff.concat(this.render(\"" + to_js_string_literal(partials[trim(name)]) + "\", global_context, context_for_partial, partials));\n";
        break;
      case "{": // the triple mustache is unescaped
        compiled_content = "buff = buff.concat(this.find(\"" + name + "\", partial_context, global_context));\n";
        break;
      default: // escape the value
        compiled_content = "buff = buff.concat(this.escape_html(this.find(\"" + name + "\", partial_context, global_context)));\n";
      }
      return compiled_before +  compiled_content +  compiled_after;
    })
  };

  function set_delimiters(delimiters) {
    function escape_for_regexp(text) {
      // thank you Simon Willison
      if(!arguments.callee.sRE) {
        var specials = [
          '/', '.', '*', '+', '?', '|',
          '(', ')', '[', ']', '{', '}', '\\'
        ];
        arguments.callee.sRE = new RegExp(
          '(\\' + specials.join('|\\') + ')', 'g'
        );
      }
      return text.replace(arguments.callee.sRE, '\\$1');
    }

    var dels = delimiters.split(" ");
    otag = escape_for_regexp(dels[0]);
    ctag = escape_for_regexp(dels[1]);
    set_regexps();
  };

  return {
    name: "mustache.js",
    version: "0.4.0-dev-twitter",

    to_html: function(template, view, partials, send_fun) {
      var result = renderer.render(template, view || {}, null, partials);
      if (send_fun) {
        return send_fun(result);
      } else {
        return result;
      }
    }
  }
}

var Mustache = DrawMustache({
  otag: "{{",
  ctag: "}}",
  translate: _
});
