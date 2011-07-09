/*
  mustache.js — Logic-less templates in JavaScript

  See http://mustache.github.com/ for more info.
*/

var Mustache = function() {
  var Renderer = function() {};

  Renderer.prototype = {
    otag: "{{",
    ctag: "}}",
    pragmas: {},
    buffer: [],
    pragmas_implemented: {
      "IMPLICIT-ITERATOR": true
    },
    context: {},
    compiled_templates: {},

    render: function(template, context, partials) {
      var compiled_template = this.compiled_templates[template];
      if (compiled_template == null) {
        compiled_template = this.compile_template(template, partials);
        this.compiled_templates[template] = compiled_template;
      }
      return compiled_template.call(this, context, partials);
    },

    compile_template: function(template, partials) {
      if (!this.includes("", template)) { // template is a constant string
        return function() { return template };
      }

      // get the pragmas together
      template = this.precompile_pragmas(template);

      // render the template
      var compiled_template = this.compile_sections(template, partials)

      // render_section did not find any sections, we still need to render the tags
      if (compiled_template == null) {
        compiled_template = this.compile_tags(template, partials);
      }
      var function_body = "var buff = '';\n" + compiled_template + "\n return buff;";
      return new Function("context", "partials", function_body);
    },

    sendLines: function(text) {
      if (text) {
        var lines = text.split("\n");
        for (var i = 0; i < lines.length; i++) {
          this.send(lines[i]);
        }
      }
    },

    /*
      Looks for %PRAGMAS
    */
    precompile_pragmas: function(template) {
      // no pragmas
      if(!this.includes("%", template)) {
        return template;
      }

      var that = this;
      var regex = new RegExp(this.otag + "%([\\w-]+) ?([\\w]+=[\\w]+)?" +
            this.ctag);
      return template.replace(regex, function(match, pragma, options) {
        if(!that.pragmas_implemented[pragma]) {
          throw({message:
            "This implementation of mustache doesn't understand the '" +
            pragma + "' pragma"});
        }
        that.pragmas[pragma] = {};
        if(options) {
          var opts = options.split("=");
          that.pragmas[pragma][opts[0]] = opts[1];
        }
        return "";
        // ignore unknown pragmas silently
      });
    },

    /*
      Renders inverted (^) and normal (#) sections
    */
    compile_sections: function(template, partials) {
      if(!this.includes("#", template) && !this.includes("^", template)) {
        // did not render anything, there were no sections
        return null;
      }

      var that = this;

      // This regex matches _the first_ section ({{#foo}}{{/foo}}), and captures the remainder
      var regex = new RegExp(
        "^([\\s\\S]*?)" +         // all the crap at the beginning that is not {{*}} ($1)

        this.otag +               // {{
        "(\\^|\\#)\\s*(.+)\\s*" + //  #foo (# == $2, foo == $3)
        this.ctag +               // }}

        "\n*([\\s\\S]*?)" +       // between the tag ($2). leading newlines are dropped

        this.otag +               // {{
        "\\/\\s*\\3\\s*" +        //  /foo (backreference to the opening tag).
        this.ctag +               // }}

        "\\s*([\\s\\S]*)$",       // everything else in the string ($4). leading whitespace is dropped.

      "g");

      // for each {{#foo}}{{/foo}} section do...
      return template.replace(regex, function(match, before, type, name, content, after) {
        // before contains only tags, no sections
        var compiled_before = before ? that.compile_tags(before, partials) : "",

        // after may contain both sections and tags, so use full rendering function
            compiled_after = after ? that.compile_template(after, partials) : "",

        // will be computed below
            compiled_content = "";

        compiled_content = compiled_content.concat(
          "var value = Mustache.find(\"" + name + "\", context);\n" +
          "var content = \"" + Mustache.escape_quotes(content) + "\";\n");

        if (type === "^") { // inverted section
          compiled_content = compiled_content.concat(
            "if (!value || Mustache.is_array(value) && value.length === 0) {\n" +
              that.compile_template(content, partials) + // false or empty list, render it
            "}"
          )
        } else if (type === "#") { // normal section
          var iterator = ".";
          if (that.pragmas["IMPLICIT-ITERATOR"]) {
            iterator = that.pragmas["IMPLICIT-ITERATOR"].iterator;
          }

          compiled_content = compiled_content.concat(
            "if (Mustache.is_array(value)) { // Enumerable, Let's loop!\n" +
            "  for (var i = 0; i < value.length; i++) {\n" +
            "    buff = buff.concat(this.render(content, Mustache.aug(context, {\"" + iterator + "\": value[i]}), partials))\n" +
            "  }\n" +
            "} else if (Mustache.is_object(value)) { // Object, Use it as subcontext!\n" +
            "    buff = buff.concat(this.render(content, value, partials))\n" +
            "} else if (typeof value === \"function\") {\n" +
            "  // higher order section\n" +
            "  renderedContent = value.call(context, content, function(text) {\n" +
            "    buff = buff.concat(this.render(text, context, partials));\n" +
            "  });\n" +
            "} else if (value) { // boolean section\n" +
            "    buff = buff.concat(this.render(content, context, partials));\n" +
            "}\n"
          )
        }

        return compiled_before + compiled_content + compiled_after;
      });
    },

    /*
      Replace {{foo}} and friends with values from our view
    */
    compile_tags: function(template, partials) {
      if (!this.includes("", template)) {
        return "buff = buff.concat(\"" + Mustache.escape_quotes(template) + "\");\n"
      }

      var that = this;

      var new_regex = function() {
        return new RegExp("^([\\s\\S]*?)" + that.otag + "(=|!|>|\\{|%)?([^\\/#\\^]+?)\\1?" +
          that.ctag + "\([\\s\\S]*)$", "g");
      };

      var regex = new_regex();
      var tag_replace_callback = function(match, before, operator, name, after) {
        var compiled_before = "buff = buff.concat(\"" + Mustache.escape_quotes(before) + "\");\n",
          compiled_after = that.compile_tags(after, partials);
          compiled_content = "";

        switch(operator) {
        case "!": // ignore comments
          break;
        case "=": // set new delimiters, rebuild the replace regexp
          that.set_delimiters(name);
          regex = new_regex();
          break;
        case ">": // render partial
          var name = Mustache.trim(name);
          compiled_content = "buff = buff.concat(this.render(\"" + Mustache.escape_quotes(partials[name]) + "\", Mustache.aug(context, context[\"" + name + "\"], partials)));\n";
          break;
        case "{": // the triple mustache is unescaped
          compiled_content = "buff = buff.concat(Mustache.find(\"" + name + "\", context));\n";
          break;
        default: // escape the value
          compiled_content = "buff = buff.concat(Mustache.escape_html(Mustache.find(\"" + name + "\", context)));\n";
        }
        return compiled_before + "\n" + compiled_content + "\n" + compiled_after;
      };
      return template.replace(regex, tag_replace_callback)
    },

    set_delimiters: function(delimiters) {
      var dels = delimiters.split(" ");
      this.otag = this.escape_regex(dels[0]);
      this.ctag = this.escape_regex(dels[1]);
    },

    escape_regex: function(text) {
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
    },

    // Utility methods

    /* includes tag */
    includes: function(needle, haystack) {
      return haystack.indexOf(this.otag + needle) != -1;
    },
  };

  return({
    name: "mustache.js",
    version: "0.3.1-dev-twitter",

    /*
      Turns a template and view into HTML
    */
    to_html: function(template, view, partials, send_fun) {
      var renderer = new Renderer();
      var result = renderer.render(template, view || {}, partials);
      if (send_fun) {
        return send_fun(result);
      } else {
        return result;
      }
    }
  });
}();

/*
  find `name` in current `context`. That is find me a value
  from the view object
*/
Mustache.find = function(name, context) {
  name = this.trim(name);

  // Checks whether a value is thruthy or false or 0
  function is_kinda_truthy(bool) {
    return bool === false || bool === 0 || bool;
  }

  var value;
  if(is_kinda_truthy(context[name])) {
    value = context[name];
  }

  if(typeof value === "function") {
    return value.apply(context);
  }
  if(value !== undefined) {
    return value;
  }
  // silently ignore unkown variables
  return "";
};

Mustache.is_object = function(a) {
  return a && typeof a == "object";
};

Mustache.is_array = function(a) {
  return Object.prototype.toString.call(a) === '[object Array]';
};

/*
  Gets rid of leading and trailing whitespace
*/
Mustache.trim = function(s) {
  return s.replace(/^\s*|\s*$/g, "");
};

Mustache.escape_quotes = function(str) {
  str = str.replace(/"/g, "\"");
  str = str.replace(/\n/g, "\\n");
  return str;
};

Mustache.aug = function() {
  result = {};
  for (var i = 0; i < arguments.length; i++) {
    for (var key in arguments[i]) {
      if (arguments[i].hasOwnProperty(key))
        result[key] = arguments[i][key];
    }
  }
  return result;
}

/*
  Does away with nasty characters
*/
Mustache.escape_html = function(s) {
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
  });
};

