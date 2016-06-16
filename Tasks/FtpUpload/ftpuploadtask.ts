/// <reference path="../../definitions/vsts-task-lib.d.ts" />
/// <reference path="../../definitions/node.d.ts" />

import fs = require('fs');
import os = require('os');
import path = require('path');
import tl = require('vsts-task-lib/task');
import url = require('url');

var win = os.type().match(/^Win/);
tl.debug('win: ' + win);

var repoRoot : string = tl.getVariable('build.sourcesDirectory');
function makeAbsolute(normalizedPath: string): string {
    tl.debug('makeAbsolute:' + normalizedPath);

    var result = normalizedPath;
    if (!path.isAbsolute(normalizedPath)) {
        result = path.join(repoRoot, normalizedPath);
        tl.debug('Relative file path: '+ normalizedPath+' resolving to: ' + result);
    }
    return result;
}

function failTask(message: string) {
    tl.setResult(tl.TaskResult.Failed, message);
}

// server endpoint
var serverEndpoint = tl.getInput('serverEndpoint', true);
var serverEndpointUrl : url.Url = url.parse(tl.getEndpointUrl(serverEndpoint, false));
//var serverEndpointUrl : url.Url = url.parse('ftp://jasholl-laptop');
tl.debug('serverEndpointUrl=' + JSON.stringify(serverEndpointUrl));

var serverEndpointAuth = tl.getEndpointAuthorization(serverEndpoint, false);
var username = serverEndpointAuth['parameters']['username'];
var password = serverEndpointAuth['parameters']['password'];
//var username = 'jasholl';
//var password = 'w2#er45T';

// the root location which will be uploaded from
var rootFolder: string = makeAbsolute(tl.getPathInput('rootFolder', true).trim());
if(!tl.exist(rootFolder)){
    failTask('The specified root folder: '+rootFolder+' does not exist.');
} 

/**
 * The relative root for computing upload file paths.
 * e.g. if root folder is /a/b/c/ and relative relativeRootFolder is a/b/
 * then the resulting upload path would be c
 */
var relativeRootFolder: string = tl.getPathInput('relativeRootFolder'); 
if(!relativeRootFolder){
    relativeRootFolder = path.dirname(rootFolder);
    tl.debug('relativeRootFolder not set, defaulting to: '+relativeRootFolder);
} else if(!tl.exist(relativeRootFolder)){
    failTask('The specified relative root folder: '+relativeRootFolder+ ' does not exist.');
} else {
    relativeRootFolder = makeAbsolute(relativeRootFolder.trim());
    var stats = tl.stats(relativeRootFolder);
    if(!stats.isDirectory){
        failTask('The specified relative root folder: '+relativeRootFolder + ' is not a folder.');
    }
    if(rootFolder.indexOf(relativeRootFolder) !== 0){
        failTask('The specified root folder: '+rootFolder+' is not within the specified relative root folder: '+relativeRootFolder);
    }
}

function findFiles(): string[] {
    tl.debug('Searching for files to upload');

    var rootFolderStats = tl.stats(rootFolder);
    if(rootFolderStats.isFile()){
        console.log(rootFolder + ' is a file. Ignoring all file patterns');
        return [rootFolder];
    }

    // filePatterns is a multiline input containing glob patterns
    var filePatterns: string[] = tl.getDelimitedInput('filePatterns', '\n', true);

    tl.debug('using: ' + filePatterns.length + ' filePatterns: '+filePatterns +' to search for files.');

    // minimatch options
    var matchOptions = { matchBase: true };
    if (win) {
        matchOptions["nocase"] = true;
    }

    var allFiles = tl.find(rootFolder);
    tl.debug('Candidates found for match: ' + allFiles.length);

    // use a set to avoid duplicates
    var SortedSet = require('collections/sorted-set');
    var matchingFilesSet = new SortedSet();

    for (var i = 0; i < filePatterns.length; i++) {
        tl.debug('searching for files, pattern['+i+']: ' + filePatterns[i]);

        var normalizedPattern : string = path.normalize(filePatterns[i]);
        tl.debug('normalizedPattern= ' + normalizedPattern);

        var matched = tl.match(allFiles, normalizedPattern, matchOptions);

        // ensure each result is only added once
        for (var j = 0; j < matched.length; j++) {
            var match = path.normalize(matched[j]);
            if (matchingFilesSet.add(match)){
                tl.debug('adding file: ' + match);
            }
        }
    }

    return matchingFilesSet.sorted();
}

var remotePath = tl.getInput('remotePath', true).trim();

var Client = require('ftp');
var c = new Client();

var files = findFiles();

c.on('ready', function() {
    var fileCount : number = 0;
    var dirCount : number = 0; 
    var Set = require('collections/set');
    var createdDirectories = new Set();
    
    tl.debug('connected to ftp host:'+serverEndpointUrl.host);
    tl.debug('files to process: '+files.length);
    for(var i = 0; i<files.length; i++){
        var file: string = files[i];
        tl.debug('file: ' + file);
        var relativePath : string = file.substring(relativeRootFolder.length);
        tl.debug('relativePath: ' + relativePath);
        var ftpRemotePath: string = path.join(remotePath, relativePath);
        tl.debug('ftpRemotePath: '+ ftpRemotePath);

        var stats = tl.stats(file);
        
        //ensure directory is created
        var dir = stats.isDirectory() ? ftpRemotePath : path.normalize(path.dirname(ftpRemotePath));
        if(createdDirectories.add(dir)){
            tl.debug('checking for remote path: '+dir);
            c.mkdir(dir, true, function (err){
                if(err){
                    c.end();
                    failTask('Unable to create remote directory: '+dir+ ' due to error: '+err);
                } //else if(stats.isDirectory()){
                    tl.debug('remote directory successfully created: '+ftpRemotePath);
                    dirCount++;
                    var total : number =  dirCount + fileCount;
                    var remaining: number = files.length - total; 
                    tl.debug('dirCount: '+ dirCount + ', fileCount: '+fileCount + ', total: '+ total + ', remaining: '+ remaining);
                    if(remaining == 0){
                        c.end();
                        tl.setResult(tl.TaskResult.Succeeded, 
                            'Ftp upload successful'+
                            '\nhost: '+ serverEndpointUrl.host + 
                            '\npath: '+ remotePath +
                            '\n directories created: ' + dirCount + 
                            '\n files uploaded: ' + fileCount
                        );
                    } 
                //}
            });
        }

        if(!stats.isDirectory()) { // upload files only
            tl.debug('uploading file: '+ftpRemotePath);
            c.put(file, ftpRemotePath, function(err){
                if(err){
                    c.end();
                    failTask('Unable to upload file: '+file + ' due to error: '+err);
                } else {
                    tl.debug('file successfully uploaded: '+ftpRemotePath);
                    fileCount ++;
                    var total : number =  dirCount + fileCount;
                    var remaining: number = files.length - total; 
                    tl.debug('dirCount: '+ dirCount + ', fileCount: '+fileCount + ', total: '+ total + ', remaining: '+ remaining);
                    if(remaining == 0){
                        c.end();
                        tl.setResult(tl.TaskResult.Succeeded, 
                            'Ftp upload successful'+
                            '\nhost: '+ serverEndpointUrl.host + 
                            '\npath: '+ remotePath +
                            '\n directories created: ' + dirCount + 
                            '\n files uploaded: ' + fileCount
                        );
                    } 
                }
            });
        }
    }
});

var secure = serverEndpointUrl.protocol == 'ftps:' ? true : false;
tl.debug('secure ftp='+secure);

c.connect({'host':serverEndpointUrl.host, 'user':username, 'password':password, 'secure':secure});


