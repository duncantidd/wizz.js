class CodeBuilder {
  constructor() {
    this.lines = [];
    this.indentLevel = 0;
  }

  /**
   * Adds a line of code with the current level of indentation.
   * @param {string} code - The code to add.
   */
  add(code) {
    if (typeof code !== 'string') {
      throw new TypeError('Code line must be a string.');
    }

    // We use two spaces for each indentation level
    const indentation = '  '.repeat(this.indentLevel);
    this.lines.push(`${indentation}${code}`);
    return this; // Returning 'this' allows for method chaining
  }

  /**
   * Increases the indentation level for subsequent lines.
   */
  indent() {
    this.indentLevel++;
    return this;
  }

  /**
   * Decreases the indentation level for subsequent lines.
   */
  dedent() {
    if (this.indentLevel > 0) {
      this.indentLevel--;
    }
    return this;
  }

  /**
   * Compiles the array of lines into a single string.
   */
  generate() {
    return this.lines.join('\n');
  }
}

module.exports = { CodeBuilder };