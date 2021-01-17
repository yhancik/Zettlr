/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL directory functions
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains utility functions for dealing with directories.
 *
 * END HEADER
 */

import path from 'path'
import { promises as fs } from 'fs'
import hash from '../../../common/util/hash'
import sortDir from './util/sort'
import isDir from '../../../common/util/is-dir'
import isFile from '../../../common/util/is-file'
import ignoreDir from '../../../common/util/ignore-dir'
import ignoreFile from '../../../common/util/ignore-file'
import safeAssign from '../../../common/util/safe-assign'
import isAttachment from '../../../common/util/is-attachment'

import { shell } from 'electron'

import * as FSALFile from './fsal-file'
import * as FSALCodeFile from './fsal-code-file'
import * as FSALAttachment from './fsal-attachment'
import {
  DirDescriptor,
  DirMeta,
  MaybeRootMeta,
  AnyDescriptor,
  MaybeRootDescriptor
} from './types'
import FSALCache from './fsal-cache'

/**
 * Determines what will be written to file (.ztr-directory)
 */
const SETTINGS_TEMPLATE = {
  'sorting': 'name-up',
  'project': null, // Default: no project
  'icon': null // Default: no icon
}

const ALLOWED_CODE_FILES = [
  '.tex'
]

const MARKDOWN_FILES = [
  '.md',
  '.rmd',
  '.markdown',
  '.txt'
]

/**
 * Used to insert a default project
 */
const PROJECT_TEMPLATE = {
  // General values that not only pertain to the PDF generation
  'title': 'Untitled', // Default project title is the directory's name
  'format': 'pdf', // Can be PDF, HTML, DOCX, and ODT.
  'cslStyle': '', // A path to an optional CSL style file.
  'pdf': {
    'author': 'Generated by Zettlr',
    // PDF keywords are seldomly used
    'keywords': '',
    // papertype is a value that XeLaTeX expects
    'papertype': 'a4paper',
    // pagenumbering must also be a value that XeLaTeX accepts
    'pagenumbering': 'arabic',
    // All four paper margins
    'tmargin': 3,
    'rmargin': 3,
    'bmargin': 3,
    'lmargin': 3,
    'margin_unit': 'cm',
    'lineheight': '1.2', // TODO: Why is this a string?
    'mainfont': 'Times New Roman',
    'sansfont': 'Arial',
    'fontsize': 12,
    'toc': true, // Default: generate table of contents
    'tocDepth': 2, // Default: Include headings 1+2 in TOCs
    'titlepage': true, // Generate a title page by default
    'textpl': '' // Can be used to store a custom TeX template
  }
}

/**
 * Allowed child sorting methods
 */
const SORTINGS = [
  'name-up',
  'name-down',
  'time-up',
  'time-down'
]

/**
 * This function returns a sanitized, non-circular
 * version of dirObject.
 * @param {DirDescriptor} dirObject A directory descriptor
 */
export function metadata (dirObject: DirDescriptor): DirMeta {
  // Handle the children
  let children = dirObject.children.map((elem) => {
    if (elem.type === 'directory') {
      return metadata(elem)
    } else if (elem.type === 'file') {
      return FSALFile.metadata(elem)
    } else if (elem.type === 'code') {
      return FSALCodeFile.metadata(elem)
    }
  }) as MaybeRootMeta[]

  return {
    // By only passing the hash, the object becomes
    // both lean AND it can be reconstructed into a
    // circular structure with NO overheads in the
    // renderer.
    parent: (dirObject.parent !== null) ? dirObject.parent.hash : null,
    path: dirObject.path,
    dir: dirObject.dir,
    name: dirObject.name,
    hash: dirObject.hash,
    // The project itself is not needed, renderer only checks if it equals
    // null, or not (then it means there is a project)
    project: (dirObject._settings.project !== null) ? true : null,
    children: children,
    attachments: dirObject.attachments.map(elem => FSALAttachment.metadata(elem)),
    type: dirObject.type,
    sorting: dirObject._settings.sorting,
    icon: dirObject._settings.icon,
    modtime: dirObject.modtime,
    creationtime: dirObject.creationtime,
    // Include the optional dirNotFoundFlag
    dirNotFoundFlag: dirObject.dirNotFoundFlag
  }
}

/**
 * Sorts the children-property of "dir"
 * @param {Object} dir A directory descriptor
 */
function sortChildren (dir: DirDescriptor): void {
  dir.children = sortDir(dir.children, dir._settings.sorting)
}

/**
 * Persists the settings of a directory to disk.
 * @param {Object} dir The directory descriptor
 */
async function persistSettings (dir: DirDescriptor): Promise<void> {
  const settingsFile = path.join(dir.path, '.ztr-directory')
  const hasDefaultSettings = JSON.stringify(dir._settings) === JSON.stringify(SETTINGS_TEMPLATE)
  if (hasDefaultSettings && isFile(settingsFile)) {
    // Only persist the settings if they are not default. If they are default,
    // remove a possible .ztr-directory-file
    try {
      await fs.unlink(settingsFile)
    } catch (e) {
      const msg = e.message as string
      global.log.error(`Error removing default .ztr-directory: ${msg}`, e)
    }
  }
  await fs.writeFile(path.join(dir.path, '.ztr-directory'), JSON.stringify(dir._settings))
}

/**
 * Parses a settings file for the given directory.
 * @param {Object} dir The directory descriptor.
 */
async function parseSettings (dir: DirDescriptor): Promise<void> {
  let configPath = path.join(dir.path, '.ztr-directory')
  try {
    let settings: any = await fs.readFile(configPath, { encoding: 'utf8' })
    settings = JSON.parse(settings)
    dir._settings = safeAssign(settings, SETTINGS_TEMPLATE)
    if (settings.project !== null) {
      // We have a project, so we need to sanitize the values (in case
      // that there have been changes to the config). We'll just use
      // the code from the config provider.
      dir._settings.project = safeAssign(settings.project, PROJECT_TEMPLATE)
    }
    if (JSON.stringify(dir._settings) === JSON.stringify(SETTINGS_TEMPLATE)) {
      // The settings are the default, so no need to write them to file
      await fs.unlink(configPath)
    }
  } catch (e) {
    // Something went wrong
    global.log.error(`Could not parse settings file for ${dir.name}`, e)
  }
}

/**
 * Reads in a file tree recursively, returning the directory descriptor object.
 * @param {String} currentPath The current path of the directory
 * @param {FSALCache} cache A cache object so that the files can cache themselves
 * @param {Mixed} parent A parent (or null, if it's a root)
 */
async function readTree (currentPath: string, cache: FSALCache, parent: DirDescriptor|null): Promise<DirDescriptor> {
  // Prepopulate
  let dir: DirDescriptor = {
    parent: parent,
    path: currentPath,
    name: path.basename(currentPath),
    dir: path.dirname(currentPath),
    hash: hash(currentPath),
    children: [],
    attachments: [],
    type: 'directory',
    modtime: 0, // You know when something has gone wrong: 01.01.1970
    creationtime: 0,
    _settings: JSON.parse(JSON.stringify(SETTINGS_TEMPLATE))
  }

  // Retrieve the metadata
  try {
    let stats = await fs.lstat(dir.path)
    dir.modtime = stats.ctimeMs
    dir.creationtime = stats.birthtimeMs
  } catch (e) {
    global.log.error(`Error reading metadata for directory ${dir.path}!`, e)
    // Re-throw so that the caller knows something's afoul
    throw new Error(e)
  }

  // Now parse the directory contents recursively
  let children = await fs.readdir(dir.path)
  for (let child of children) {
    if (child === '.ztr-directory') {
      // We got a settings file, so let's try to read it in
      await parseSettings(dir)
      continue // Done!
    }

    // Helper vars
    let absolutePath = path.join(dir.path, child)
    let isInvalidDir = isDir(absolutePath) && ignoreDir(absolutePath)
    let isInvalidFile = isFile(absolutePath) && ignoreFile(absolutePath)

    // Is the child invalid?
    if (isInvalidDir || (isInvalidFile && !isAttachment(absolutePath))) continue

    // Parse accordingly
    let start = Date.now()
    if (isAttachment(absolutePath)) {
      dir.attachments.push(await FSALAttachment.parse(absolutePath, dir))
    } else if (isFile(absolutePath)) {
      const isCode = ALLOWED_CODE_FILES.includes(path.extname(absolutePath))
      const isMD = MARKDOWN_FILES.includes(path.extname(absolutePath))
      if (isCode) {
        dir.children.push(await FSALCodeFile.parse(absolutePath, cache, dir))
      } else if (isMD) {
        dir.children.push(await FSALFile.parse(absolutePath, cache, dir))
      }
    } else if (isDir(absolutePath)) {
      dir.children.push(await readTree(absolutePath, cache, dir))
    }

    if (Date.now() - start > 100) {
      // Only log if it took longer than 50ms
      global.log.warning(`[FSAL Directory] Path ${absolutePath} took ${Date.now() - start}ms to load.`)
    }
  }

  // Finally sort and return the directory object
  sortChildren(dir)
  return dir
}

export async function parse (dirPath: string, cache: FSALCache, parent: DirDescriptor|null = null): Promise<DirDescriptor> {
  return await readTree(dirPath, cache, parent)
}

export function getDirNotFoundDescriptor (dirPath: string): DirDescriptor {
  return {
    parent: null, // Always a root
    path: dirPath,
    name: path.basename(dirPath),
    dir: path.dirname(dirPath),
    hash: hash(dirPath),
    children: [], // Always empty
    attachments: [], // Always empty
    type: 'directory',
    modtime: 0, // ¯\_(ツ)_/¯
    creationtime: 0,
    // Settings are expected by some functions
    _settings: JSON.parse(JSON.stringify(SETTINGS_TEMPLATE)),
    dirNotFoundFlag: true
  }
}

// Sets an arbitrary setting on the directory object.
export async function setSetting (dirObject: DirDescriptor, settings: any): Promise<void> {
  dirObject._settings = safeAssign(settings, dirObject._settings)
  await persistSettings(dirObject)
}

export async function createFile (dirObject: DirDescriptor, options: any, cache: FSALCache): Promise<void> {
  let filename = options.name
  let content = options.content
  let fullPath = path.join(dirObject.path, filename)
  await fs.writeFile(fullPath, content)
  let file = await FSALFile.parse(fullPath, cache, dirObject)
  dirObject.children.push(file)
  sortChildren(dirObject)
}

export async function sort (dirObject: DirDescriptor, method: string = ''): Promise<void> {
  // If the caller omits the method, it should remain unchanged
  if (method === '') method = dirObject._settings.sorting
  if (!SORTINGS.includes(method)) throw new Error('Unknown sorting: ' + method)
  dirObject._settings.sorting = method
  // Persist the settings to disk
  await persistSettings(dirObject)
  sortChildren(dirObject)
}

/**
 * Assigns new project properties to a directory.
 * @param {Object} dirObject Directory descriptor
 * @param {Object} properties New properties
 */
export async function updateProjectProperties (dirObject: DirDescriptor, properties: any): Promise<void> {
  dirObject._settings.project = safeAssign(properties, dirObject._settings.project)
  // Immediately reflect on disk
  await persistSettings(dirObject)
}

// Makes a new project
export async function makeProject (dirObject: DirDescriptor, properties: any): Promise<void> {
  dirObject._settings.project = safeAssign(properties, PROJECT_TEMPLATE)
  await persistSettings(dirObject)
}

// Removes a project
export async function removeProject (dirObject: DirDescriptor): Promise<void> {
  dirObject._settings.project = null
  await persistSettings(dirObject)
}

/**
 * Creates a new directory within the given descriptor.
 *
 * @param   {DirDescriptor}  dirObject  The source directory
 * @param   {string}         newName    The name for the new directory
 * @param   {FSALCache}      cache      The cache object
 *
 * @return  {Promise<void>}             Resolves void
 */
export async function create (dirObject: DirDescriptor, newName: string, cache: FSALCache): Promise<void> {
  if (newName.trim() === '') throw new Error('Invalid directory name provided!')
  let existingDir = dirObject.children.find(elem => elem.name === newName)
  if (existingDir !== undefined) throw new Error(`A child with name ${newName} already exists!`)
  let newPath = path.join(dirObject.path, newName)
  await fs.mkdir(newPath)
  let newDir = await readTree(newPath, cache, dirObject)
  // Add the new directory to the source dir
  dirObject.children.push(newDir)
  sortChildren(dirObject)
}

export async function rename (dirObject: DirDescriptor, newName: string, cache: FSALCache): Promise<DirDescriptor> {
  // Check some things beforehand
  if (newName.trim() === '') throw new Error('Invalid directory name provided!')
  let parentNames = await fs.readdir(path.dirname(dirObject.path))
  if (parentNames.includes(newName)) throw new Error(`Directory ${newName} already exists!`)

  let newPath = path.join(path.dirname(dirObject.path), newName)
  await fs.rename(dirObject.path, newPath)
  // Rescan the new dir to get all new file information
  let newDir = await readTree(newPath, cache, dirObject.parent)
  if (dirObject.parent !== null) {
    // Exchange the directory in the parent
    let index = dirObject.parent.children.indexOf(dirObject)
    dirObject.parent.children.splice(index, 1, newDir)
    // Now sort the parent
    sortChildren(dirObject.parent)
  }

  // Return the new directory -- either to replace it in the filetree, or,
  // if applicable, the openDirectory
  return newDir
}

export async function remove (dirObject: DirDescriptor): Promise<void> {
  // First, get the parent, if there is any
  let parentDir = dirObject.parent
  const deleteOnFail: boolean = global.config.get('system.deleteOnFail')
  const deleteSuccess = shell.moveItemToTrash(dirObject.path, deleteOnFail)
  // Now, remove the directory
  if (deleteSuccess && parentDir !== null) {
    // Splice it from the parent directory
    parentDir.children.splice(parentDir.children.indexOf(dirObject), 1)
  }

  if (!deleteSuccess) {
    // Forcefully remove the directory
    fs.rmdir(dirObject.path)
      .catch(err => {
        global.log.error(`[FSAL Directory] Could not remove directory ${dirObject.path}: ${err.message as string}`, err)
      })
  }
}

export async function move (sourceObject: AnyDescriptor, targetDir: DirDescriptor, cache: FSALCache): Promise<void> {
  // Moves anything into the target. We'll use fs.rename for that.
  // Luckily, it doesn't care if it's a directory or a file, so just
  // stuff the path into that.
  let sourcePath = sourceObject.path
  let targetPath = path.join(targetDir.path, sourceObject.name)
  await fs.rename(sourcePath, targetPath)

  // Now remove the source from its parent (which in any case is a directory)
  let oldChildren = sourceObject.parent?.children
  if (oldChildren !== undefined) {
    oldChildren.splice(oldChildren.indexOf(sourceObject as MaybeRootDescriptor), 1)
  }

  // Re-read the source
  let newSource
  if (sourceObject.type === 'directory') {
    newSource = await readTree(targetPath, cache, targetDir)
  } else {
    newSource = await FSALFile.parse(targetPath, cache, targetDir)
  }

  // Add it to the new target
  targetDir.children.push(newSource)

  // Finally resort the target. Now the state should be good to go.
  sortChildren(targetDir)
}