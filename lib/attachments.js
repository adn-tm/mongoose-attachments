// Copyright (c) 2011-2013 Firebase.co - http://www.firebase.co
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

var im = require('imagemagick');
var fs = require('fs');
var path = require('path');
var async = require('async');
var existsFn = fs.exists || path.exists;
var _=require("underscore");

// keeps a global registry of storage providers
var providersRegistry = {};

var supportedDecodingFormats = [
	'PNG',
	'GIF',
	'TIFF',
	'JPEG'
];

function findProvider(name) {
	var provider = providersRegistry[name];
	if(!provider) throw new Error('Storage Provider "' + name + '" can not be found');
	return provider;
}

function findImageMagickFormats(options, callback) {
	var opts = { read: true };
	if(typeof options === 'function') {
		callback = options;
	} else if(options.read || options.write || options.multi || options.blob ) {
		opts = options;
	} else {
		callback(new Error("Options have to contain one or more of 'read', 'write', 'multi', 'blob'"));
	}
	im.convert(['-list','format'], function(err, stdout, stderr) {
		if(err) return callback(err);
		if(stderr && stderr.search(/\S/) >= 0) return callback(new Error(stderr));
		if(stdout && stdout.search(/\S/) >= 0) {
			// capture groups:
			// 0: all
			// 1: format
			// 2: if '*' = native blob support; if ' ' (whitespace) none. Not set with graphicsmagick - therefore optional in regex
			// 3: module
			// 4: if 'r' = read support; if '-' none
			// 5: if 'w' = write support; if '-' none
			// 6: if '+' = support for multiple images; if '-' none
			// 7: description
			var regex = /^\s*([^\*\s]+)(\*|\s)?\s(\S+)\s+([-r])([-w])([-+])\s+(.*)$/;
			var lines = stdout.split("\n");
			var comps = [];
			var formats = [];
			var i, currentLine;
			for (i in lines) {
				currentLine = lines[i];
				comps = regex.exec(currentLine);
				if(comps) {
					if((!opts.read  || comps[4] === 'r') &&
							(!opts.write || comps[5] === 'w') &&
							(!opts.multi || comps[6] === '+') &&
							(!opts.blob  || comps[2] === '*')) {
						formats.push(comps[1]);
					}
				}
			}
			return callback(null,formats);
		} else {
			return callback(new Error("No format supports the requested operation(s): "
											 + Object.keys(opts).toString()
											 + " . Check 'convert -list format'"));
		}
	});
}

var plugin = function(schema, options) {
	options = options || {};
	if(typeof(options.directory) !== 'string') throw new Error('option "directory" is required');
	if(typeof(options.properties) !== 'object') throw new Error('option "properties" is required');
	if(typeof(options.storage) !== 'object') throw new Error('option "storage" is required');
	if(typeof(options.idAsDirectory) !== 'boolean') options.idAsDirectory = false;
	if(typeof(options.keepRelativePath) !== 'boolean') options.keepRelativePath = true;
	if(typeof(options.urlPrefix) !== 'string') options.urlPrefix="";

	var storageOptions = options.storage;
	storageOptions.schema = schema;

	if(typeof(storageOptions.providerName) !== 'string') throw new Error('option "storage.providerName" is required');
	var providerPrototype = findProvider(storageOptions.providerName);

	var providerOptions = storageOptions.options || {};
	var providerInstance = new providerPrototype(providerOptions);
	if(typeof providerInstance.getUrl !== 'function') {
		throw new Error('Provider ' + storageOptions.providerName + ' does not have a method getUrl');
	}
	if(typeof providerInstance.createOrReplace !== 'function') {
		throw new Error('Provider ' + storageOptions.providerName + ' does not have a method createOrReplace');
	}
	var propertyNames = Object.keys(options.properties);
	propertyNames.forEach(function(propertyName) {
		var propertyOptions = options.properties[propertyName];
		if(!propertyOptions) throw new Error('property "' + propertyName + '" requires an specification');

		var styles = propertyOptions.styles || {};
		var styleNames = Object.keys(styles);
		if(styleNames.length == 0) throw new Error('property "' + propertyName + '" needs to define at least one style');

		var addOp = {};
		var propSchema = addOp[propertyName] = {};
		styleNames.forEach(function(styleName) {
			propSchema[styleName] = {
				size: Number // Size of the File
				, oname: String // Original name of the file
				, mtime: Date
				, ctime: Date
				, path: String // Storage Path
				, defaultUrl: String // Default (non-secure, most of the time public) Url
				, format: String // Format of the File(provided by identify).
				, mime: String // Format of the File(provided by identify).
				, depth: Number

				, dims: { // Dimensions of the Image
					h: Number, // Height
					w: Number // Width
				}
			};
		});

		// Add the Property
		schema.add(addOp);
	}); // for each property name

	// Finally we set the method 'attach'
	// => propertyName: String. Name of the property to attach the file to.
	// => attachmentInfo: {
	//  path: String(required). Path to the file in the file system.
	//  name: String(optional). Original Name of the file.
	//  mime: String(optional). Mime type of the file.
	schema.methods.attach = function(propertyName, attachmentInfo, cb) {
		
		var selfModel = this;
		if(propertyNames.indexOf(propertyName) == -1) return cb(new Error('property "' + propertyName + '" was not registered as an attachment property'));
		var propertyOptions = options.properties[propertyName];
		var styles = propertyOptions.styles || {};
		if(!attachmentInfo || typeof(attachmentInfo) !== 'object') return cb(new Error('attachmentInfo is not valid'));
		if(typeof(attachmentInfo.path) !== 'string') return cb(new Error('attachmentInfo has no valid path'));
		if(!attachmentInfo.name) {
			// No original name provided? We infer it from the path
			attachmentInfo.name = path.basename(attachmentInfo.path);
		}
	//  console.log("attachmentInfo=", attachmentInfo);
		var identify;
		if (attachmentInfo.notImageProcessing)
				identify=function(path, cb) { return cb(null, {}, false); };
		else
				identify=function(path, cb) {
						im.identify(path, function(err, atts) {
							var canTransform = !err && !!atts && supportedDecodingFormats.indexOf(atts.format) != -1;
							return cb(err, atts, canTransform); 
						})
				};


		existsFn(attachmentInfo.path, function(exists) {
			if(!exists) return cb(new Error('file to attach at path "' + attachmentInfo.path + '" does not exists'));

			fs.stat(attachmentInfo.path, function(err, stats) {

				if(!stats.isFile()) return cb(new Error('path to attach from "' + attachmentInfo.path + '" is not a file'));
				identify(attachmentInfo.path, function(err, atts, canTransform) {  
					var fileExt = path.extname(attachmentInfo.path) || path.extname(attachmentInfo.name);
					var styles = propertyOptions.styles || {};
					var styleNames = Object.keys(styles);
				 
					var tasks = [];
					var stylesToReset = []; // names of the style that needs to be reset at the end of the process.
					
					styleNames.forEach(function(styleName) {
					var styleOptions = styles[styleName] || {};
					if(_.isObject(attachmentInfo.convert) )
						 if(_.isObject(attachmentInfo.convert[styleName]) )
								styleOptions = _.extend(styleOptions, attachmentInfo.convert[styleName]);

					 // console.log(styleName, " is covert as ", styleOptions);

						var finishConversion = function(styleFilePath, atts, cb) {
						 // console.log("Save origin for", styleFilePath)
							var ext = path.extname(styleFilePath);
							if (!ext)
									ext=  path.extname(attachmentInfo.name);
									
							var filenameId = options.filenameId ? selfModel[options.filenameId] : selfModel.id;
							var storageStylePath = [ options.directory, propertyName, [ filenameId, styleName + ext].join( options.idAsDirectory ? '/':'-') ].join('/');
							if(storageStylePath[0] != '/'){ storageStylePath = '/' + storageStylePath; }

							fs.stat(styleFilePath, function(err, stats) {
								if(err) { 
									 console.log("Origin saving error", styleFilePath, err)
									return cb(err);
								}
								cb(null, {
									style: {
										name: styleName,
										options: styleOptions
									},
									filename: styleFilePath,
									stats: stats,
									propertyName: propertyName,
									model: selfModel,
									path: storageStylePath,
									defaultUrl: null, // let the storage assign this
									defaultMime: attachmentInfo.mime,
									features: atts
								});
							});
						};

						var optionKeys = [];
						
				 //   if(canTransform) {
							optionKeys= Object.keys(styleOptions);
							var transformationNames = [];
							optionKeys.forEach(function(transformationName) {
								if(transformationName.indexOf('$') != 0) {  // if is not special command, add it as an special transformation argument
									transformationNames.push(transformationName);
								}
							});
					//  }

						if(optionKeys.length != 0) {
							if(canTransform) {
								var styleFileExt = styleOptions['$format'] ? ('.' + styleOptions['$format']) : fileExt;
								// format depedings preprocess
								// var onlyExt=fileExt.indexOf(".")==0?fileExt.substr(1):fileExt;
								var onlyExt=atts.format.toLowerCase()
								var styleFormatPreProcessing = styleOptions['$preprocess']?styleOptions['$preprocess']: {};
								styleFormatPreProcessing = styleFormatPreProcessing[onlyExt]?styleFormatPreProcessing[onlyExt]:styleFormatPreProcessing;

								var styleFormatPostProcessing = styleOptions['$postprocess']?styleOptions['$postprocess']: {};
								styleFormatPostProcessing = styleFormatPostProcessing[onlyExt]?styleFormatPostProcessing[onlyExt]:styleFormatPostProcessing;
								// console.log(onlyExt, styleName,  "styleFormatPreProcessing", styleFormatPreProcessing);
								var styleFileName = path.basename(attachmentInfo.path, fileExt);
								styleFileName += '-' + styleName + styleFileExt;
								var styleFilePath = path.join(path.dirname(attachmentInfo.path), styleFileName);
								var convertArgs = [attachmentInfo.path]; // source file name

								// add all the transformations args
								
								transformationNames.forEach(function(transformationName) {
									
									if(styleOptions[transformationName] instanceof Array) {
										convertArgs.push('-' + transformationName);
										styleOptions[transformationName].forEach(function (arg) {
											convertArgs.push(arg); 
										});
									} else  // add options for variative operations
									if (styleOptions[transformationName]===true) {
										if ( attachmentInfo[transformationName] instanceof Array)
											 attachmentInfo[transformationName].forEach(function (arg) {
												convertArgs.push(arg);
											});
									} else {
										convertArgs.push('-' + transformationName);
										convertArgs.push(styleOptions[transformationName]);
									}
								});
								var formatOptionsKey="$"+atts.format.toLowerCase();
								if (formatOptionsKey in styleOptions) {
									for(var key in styleOptions[formatOptionsKey]) {
										convertArgs.push('-' + key);
										convertArgs.push(styleOptions[formatOptionsKey][key]);
									}
								}
								convertArgs.push(styleFilePath);
								var imTask=function(cb) {
									// console.log("invoke 'convert'", convertArgs);
												im.convert(convertArgs, function(err, stdout, stderr) {
													if(err) return cb(err);
													if ((typeof styleFormatPostProcessing == "function"))
														styleFormatPostProcessing.call(selfModel, styleFilePath, function(err, newPath){
															if (err || !newPath) newPath=styleFilePath;
															im.identify(newPath, function(err, atts) {
																if(err) return cb(err);
																finishConversion(newPath, atts, cb);
															});
														})
													else 
													// run identify in the styled image
													im.identify(styleFilePath, function(err, atts) {
														if(err) return cb(err);
														finishConversion(styleFilePath, atts, cb);
													});
												});
								}
								
								if (!(typeof styleFormatPreProcessing == "function") ) 
										tasks.push(imTask); // tasks.push
								else {
									tasks.push(function(cb) {
										styleFormatPreProcessing.call(selfModel, attachmentInfo.path, function(err, preprocessed) {
											if (!err && preprocessed) {
												if (convertArgs[0]!=preprocessed) {
													convertArgs[0]=convertArgs[convertArgs.length-1]=styleFilePath=preprocessed;
												}
											}
											imTask(cb)
										})
									});
								}
							} else {
								stylesToReset.push(styleName);
							}// if can decode
						} else {
							// keep the file as original
							tasks.push(function(cb) {
								finishConversion(attachmentInfo.path, atts, cb);
							});
						}

					}); // for each style

					async.parallel(tasks, function(err, convertResults) {
						if(err) return cb(err);

						//console.log(convertResults);
						tasks = [];
						convertResults.forEach(function(convertResult) {
							tasks.push(function(cb) {

								// tell the provider to create or replace the attachment
								providerInstance.createOrReplace(convertResult, function(err, attachment) {
									if(err) return cb(err);
									cb(null, attachment);
								});

							});
						});

						async.parallel(tasks, function(err, storageResults) {
							if(err) return cb(err);

							// Finally Update the Model
							var propModel = selfModel[propertyName];
							// console.log("storageResults", storageResults);
							if(storageResults.length > 0) { // only update the model if a transformation was performed.
								storageResults.forEach(function(styleStorage) {
									var modelStyle = propModel[styleStorage.style.name];
									if(! options.keepRelativePath) {
										modelStyle.path = styleStorage.path;
										modelStyle.defaultUrl = options.urlPrefix+styleStorage.defaultUrl;
									}
									else {
										modelStyle.path = path.relative(options.directory, styleStorage.path);
											modelStyle.defaultUrl = options.urlPrefix+path.relative(options.directory, styleStorage.defaultUrl);
									}
									modelStyle.size = styleStorage.stats.size;
									modelStyle.mime = styleStorage.mime || (styleStorage.features?styleStorage.features['mime type']:false) || styleStorage.defaultMime;
									
									modelStyle.ctime = styleStorage.stats.ctime;
									modelStyle.mtime = styleStorage.stats.mtime;
									modelStyle.oname = attachmentInfo.name; // original name of the file
									if(atts && styleStorage.features) {
										modelStyle.format = styleStorage.features.format;
										modelStyle.depth = styleStorage.features.depth;
										modelStyle.dims.h = styleStorage.features.height;
										modelStyle.dims.w = styleStorage.features.width;
									}
									
								});
								
							}

							stylesToReset.forEach(function(resetStyleName) {
								var path = [propertyName, resetStyleName].join('.');
								selfModel.set(path, null);
							});

							cb(null);
						});

					});

				});
			});
		});
	}; // method attach
};

// Prototype for Storage Providers
function StorageProvider(options) {
	this.options = options;
}
StorageProvider.prototype.update = function(attachment, cb) {
	throw new Error('method update implemented');
};
plugin.StorageProvider = StorageProvider;

// Method to Register Storage Providers
plugin.registerStorageProvider = function(name, provider) {
	if(typeof(name) !== 'string') throw new Error('storage engine name is required');
	if(provider && provider._super == StorageProvider) throw new Error('provider is not valid. it does not inherits from StorageEngine');
	providersRegistry[name] = provider;
}

// Register a Known Decoding Format(e.g 'PNG')
plugin.registerDecodingFormat = function(name) {
	supportedDecodingFormats.push(name);
}

/*
 * Use this to register all formats for which your local ImageMagick installation supports
 * read operations.
 */
plugin.registerImageMagickDecodingFormats = function() {
	plugin.registerImageMagickFormats({ read: true });
}

/*
 * You can register formats based on certain modes or a combination of those:
 * 'read' : true|false
 * 'write': true|false
 * 'multi': true|false
 * 'blob' : true|false
 * options is optional and defaults to { read: true }. If several modes with value true are given,
 * only formats supporting all of them are included.
 */
plugin.registerImageMagickFormats = function(options, callback) {
	if(!callback) {
		callback = function(error, formats) {
			if(error) throw new Error(error);
			else if(formats && formats.length > 0) {
				supportedDecodingFormats = formats;
			} else {
				throw new Error("No formats supported for decoding!");
			}
		};
	}
	findImageMagickFormats(options, callback);
}

// Export the Plugin for mongoose.js
module.exports = plugin;
